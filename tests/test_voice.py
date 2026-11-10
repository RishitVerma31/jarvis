"""Unit and integration tests for VoiceService and Voice WebSocket router."""

import asyncio
import base64
import time
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from backend.config import Settings
from backend.main import app
from backend.security import get_ticket_store
from backend.services.kokoro_service import KokoroSynthesisError
from backend.services.voice_service import VoiceService


def get_test_ws_ticket() -> str:
    """Helper to generate a valid ticket for WebSocket testing."""
    return asyncio.run(get_ticket_store().create_ticket())


def test_voice_service_vad_silence():
    """Verify that WebRTC VAD correctly identifies 30ms of silence as non-speech."""
    # 30ms at 16kHz mono 16-bit = 480 samples = 960 bytes
    silence_30ms = bytes(960)

    with patch("backend.services.voice_service.WhisperModel"), patch(
        "backend.services.voice_service.Model"
    ):
        vs = VoiceService()
        is_speech = vs.is_speech_frame(silence_30ms)
        assert is_speech is False


def test_voice_service_wake_word_below_threshold():
    """Verify wake word returns False when model confidence is below threshold."""
    # 80ms at 16kHz mono 16-bit = 1280 samples = 2560 bytes
    silence_80ms = bytes(2560)

    mock_model = MagicMock()
    mock_model.models = {"hey_jarvis_v0.1": None}
    mock_model.predict.return_value = {"hey_jarvis_v0.1": 0.25}

    with patch("backend.services.voice_service.WhisperModel"), patch(
        "backend.services.voice_service.Model", return_value=mock_model
    ):
        vs = VoiceService()
        detected, score = vs.predict_wake_word(silence_80ms)
        assert detected is False
        assert score == 0.25


def test_voice_service_wake_word_above_threshold_and_cooldown():
    """Verify wake word triggers when score exceeds threshold and enforces cooldown."""
    silence_80ms = bytes(2560)

    mock_model = MagicMock()
    mock_model.models = {"hey_jarvis_v0.1": None}
    mock_model.predict.return_value = {"hey_jarvis_v0.1": 0.85}

    with patch("backend.services.voice_service.WhisperModel"), patch(
        "backend.services.voice_service.Model", return_value=mock_model
    ):
        vs = VoiceService()
        # First trigger should succeed
        detected1, score1 = vs.predict_wake_word(silence_80ms)
        assert detected1 is True
        assert score1 == 0.85

        # Immediate second trigger should be blocked by cooldown
        detected2, score2 = vs.predict_wake_word(silence_80ms)
        assert detected2 is False
        assert score2 == 0.85


@pytest.mark.asyncio
async def test_voice_service_transcribe_pcm():
    """Verify transcribe_pcm runs faster-whisper and returns formatted transcript."""
    dummy_audio = bytes(3200)

    mock_segment = MagicMock()
    mock_segment.text = "Hello Jarvis"
    mock_whisper = MagicMock()
    mock_whisper.transcribe.return_value = ([mock_segment], None)

    with patch("backend.services.voice_service.WhisperModel", return_value=mock_whisper), patch(
        "backend.services.voice_service.Model"
    ):
        vs = VoiceService()
        text, latency = await vs.transcribe_pcm(dummy_audio)
        assert text == "Hello Jarvis"
        assert latency >= 0.0


def test_voice_websocket_connect_and_state():
    """Verify WebSocket connection handshake and initial WAKE_LISTENING state."""
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as websocket:
        data = websocket.receive_json()
        assert data["type"] == "state_change"
        assert data["state"] == "WAKE_LISTENING"


def test_voice_websocket_mute_unmute_and_ping():
    """Verify WebSocket mute, unmute, and ping/pong control frames."""
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as websocket:
        # Handshake
        initial = websocket.receive_json()
        assert initial["state"] == "WAKE_LISTENING"

        # Ping
        websocket.send_json({"type": "ping"})
        pong = websocket.receive_json()
        assert pong["type"] == "pong"

        # Mute
        websocket.send_json({"type": "mute"})
        muted = websocket.receive_json()
        assert muted["type"] == "state_change"
        assert muted["state"] == "MUTED"

        # Unmute
        websocket.send_json({"type": "unmute"})
        unmuted = websocket.receive_json()
        assert unmuted["type"] == "state_change"
        assert unmuted["state"] == "WAKE_LISTENING"


def test_voice_websocket_emergency_stop():
    """Verify emergency stop resets state to WAKE_LISTENING."""
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as websocket:
        # Handshake
        websocket.receive_json()

        # Emergency stop
        websocket.send_json({"type": "emergency_stop"})
        res = websocket.receive_json()
        assert res["type"] == "state_change"
        assert res["state"] == "WAKE_LISTENING"


def test_voice_websocket_session_and_tts_completed():
    """Verify setting session and handling tts_completed."""
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as websocket:
        # Handshake
        websocket.receive_json()

        # Set session
        websocket.send_json({"type": "set_session", "session_id": "test-session-456"})

        # TTS Completed without turn_id is rejected without mutating state
        websocket.send_json({"type": "tts_completed"})
        websocket.send_json({"type": "ping"})
        pong = websocket.receive_json()
        assert pong["type"] == "pong"

        # TTS Completed with valid turn_id in WAKE_LISTENING is acknowledged safely
        websocket.send_json({"type": "tts_completed", "turn_id": 0})
        res = websocket.receive_json()
        assert res["type"] == "state_change"
        assert res["state"] == "WAKE_LISTENING"
        assert res["ack"] == "tts_completed"
        assert res["turn_id"] == 0


def _make_speech_frame(rms: float = 700.0) -> bytes:
    """Generate a 30ms (960-byte) 16kHz mono 16-bit PCM frame with controlled RMS energy."""
    import numpy as np
    samples = (np.sin(np.linspace(0, 20, 480)) * rms * 1.414).astype(np.int16)
    return samples.tobytes()


def _simulate_voice_turn(ws, silence_delay: float = 0.06) -> tuple[dict, dict]:
    """Drive a full voice turn through the WebSocket and return (chat_response, speaking_state)."""
    # 1. Send wake word PCM frame (80ms = 2560 bytes)
    ws.send_bytes(bytes(2560))
    wake_event = ws.receive_json()
    assert wake_event["type"] == "wake_detected"

    rec_state = ws.receive_json()
    assert rec_state["type"] == "state_change"
    assert rec_state["state"] == "RECORDING"

    # 2. Send valid speech PCM frames (>= 4 frames = 120ms with sufficient RMS energy)
    speech_frame = _make_speech_frame(rms=700.0)
    for _ in range(4):
        ws.send_bytes(speech_frame)
    time.sleep(silence_delay)
    # Send trailing silence frame after silence delay to trigger silence check
    ws.send_bytes(bytes(960))

    # 3. State transitions: RECORDING -> TRANSCRIBING -> transcription -> PROCESSING
    transcribing_state = ws.receive_json()
    assert transcribing_state["type"] == "state_change"
    assert transcribing_state["state"] == "TRANSCRIBING"

    transcription_event = ws.receive_json()
    assert transcription_event["type"] == "transcription"
    assert transcription_event["text"] == "hello jarvis"

    processing_state = ws.receive_json()
    assert processing_state["type"] == "state_change"
    assert processing_state["state"] == "PROCESSING"

    # 4. Chat response and speaking state
    chat_response = ws.receive_json()
    assert chat_response["type"] == "chat_response"

    speaking_state = ws.receive_json()
    assert speaking_state["type"] == "state_change"
    assert speaking_state["state"] == "SPEAKING"

    return chat_response, speaking_state


def _get_mock_voice_services(reply: str = "Hello sir, all systems nominal."):
    mock_vs = MagicMock()
    mock_vs.predict_wake_word.return_value = (True, 0.95)
    # First 4 frames are speech, subsequent frames are silence
    mock_vs.is_speech_frame.side_effect = [True, True, True, True] + [False] * 50
    mock_vs.transcribe_pcm = AsyncMock(return_value=("hello jarvis", 45.0))

    mock_chat_res = MagicMock()
    mock_chat_res.reply = reply
    mock_chat_res.session_id = "test-session-voice"
    mock_chat_res.model = "qwen2.5:3b"
    mock_chat_res.created_at = MagicMock()
    mock_chat_res.created_at.isoformat.return_value = "2026-11-10T00:00:00Z"

    return mock_vs, mock_chat_res


def test_voice_websocket_chat_response_includes_kokoro_audio():
    """Verify that when Kokoro is enabled and synthesis succeeds, chat_response has Base64 audio and metadata."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    dummy_wav = b"RIFF1234WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00"
    mock_kokoro = MagicMock()
    mock_kokoro.synthesize = AsyncMock(return_value=(dummy_wav, 125.0))

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_kokoro_service", return_value=mock_kokoro):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # Initial WAKE_LISTENING state
            chat_res, speaking = _simulate_voice_turn(ws)

            assert chat_res["reply"] == "Hello sir, all systems nominal."
            assert chat_res["audio"] == base64.b64encode(dummy_wav).decode("ascii")
            assert chat_res["audio_mime"] == "audio/wav"
            assert chat_res["voice"] == "af_bella"
            assert chat_res["metrics"]["tts_latency_ms"] == 125.0
            assert chat_res["metrics"]["stt_latency_ms"] == 45.0
            assert "llm_latency_ms" in chat_res["metrics"]
            assert speaking["state"] == "SPEAKING"


def test_voice_websocket_chat_response_when_kokoro_disabled():
    """Verify that when Kokoro is disabled, chat_response is strictly text-only without audio fields."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    mock_settings = Settings(ENABLE_KOKORO_TTS=False)

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_settings", return_value=mock_settings), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # Initial WAKE_LISTENING state
            chat_res, speaking = _simulate_voice_turn(ws)

            assert chat_res["reply"] == "Hello sir, all systems nominal."
            assert "audio" not in chat_res
            assert "audio_mime" not in chat_res
            assert "voice" not in chat_res
            assert "tts_latency_ms" not in chat_res["metrics"]
            assert speaking["state"] == "SPEAKING"


def test_voice_websocket_chat_response_falls_back_when_kokoro_fails():
    """Verify that when Kokoro synthesis raises an exception, the handler logs and falls back to text-only."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    mock_kokoro = MagicMock()
    mock_kokoro.synthesize = AsyncMock(side_effect=KokoroSynthesisError("ONNX Runtime inference error"))

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_kokoro_service", return_value=mock_kokoro):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # Initial WAKE_LISTENING state
            chat_res, speaking = _simulate_voice_turn(ws)

            # Audio fields must be safely omitted
            assert chat_res["reply"] == "Hello sir, all systems nominal."
            assert "audio" not in chat_res
            assert "audio_mime" not in chat_res
            assert "voice" not in chat_res
            assert "tts_latency_ms" not in chat_res["metrics"]
            assert speaking["state"] == "SPEAKING"

            # Connection must remain healthy and responsive
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            assert pong["type"] == "pong"


def test_voice_websocket_lifecycle_and_event_order():
    """Verify the exact event order and transition back to WAKE_LISTENING on tts_completed."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    dummy_wav = b"RIFF1234WAVEfmt "
    mock_kokoro = MagicMock()
    mock_kokoro.synthesize = AsyncMock(return_value=(dummy_wav, 80.0))

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_kokoro_service", return_value=mock_kokoro):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            # Step 1: Initial state
            init_state = ws.receive_json()
            assert init_state == {
                "type": "state_change",
                "state": "WAKE_LISTENING",
                "message": "Connected to Jarvis Voice. Listening for 'Hey Jarvis'.",
                "initial": True,
                "turn_id": 0,
            }

            # Step 2-4: Turn through to SPEAKING
            chat_res, speaking = _simulate_voice_turn(ws)
            assert chat_res["type"] == "chat_response"
            assert "audio" in chat_res
            assert speaking == {
                "type": "state_change",
                "state": "SPEAKING",
                "message": "Speaking response...",
                "turn_id": chat_res["turn_id"],
            }

            # Step 5: Client signals TTS completion with turn_id
            ws.send_json({"type": "tts_completed", "turn_id": chat_res["turn_id"]})
            resumed_state = ws.receive_json()
            assert resumed_state["type"] == "state_change"
            assert resumed_state["state"] == "WAKE_LISTENING"
            assert resumed_state["follow_up"] is True

            # Step 6: Verify ready for next interaction
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            assert pong["type"] == "pong"


def test_voice_websocket_receives_control_messages_during_long_processing():
    """Verify WebSocket receive loop stays responsive (answering pings) during simulated slow processing."""
    mock_vs, mock_chat_res = _get_mock_voice_services(reply="Story completed.")

    async def slow_process_chat(*args, **kwargs):
        await asyncio.sleep(0.15)
        return mock_chat_res

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", side_effect=slow_process_chat), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # WAKE_LISTENING

            # Wake word + speech
            ws.send_bytes(bytes(2560))
            assert ws.receive_json()["type"] == "wake_detected"
            assert ws.receive_json()["state"] == "RECORDING"

            speech_frame = _make_speech_frame(rms=700.0)
            for _ in range(4):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            # Transcribing event
            t_state = ws.receive_json()
            assert t_state["state"] == "TRANSCRIBING"

            # STT finishes quickly, then PROCESSING starts and enters slow Ollama
            transcription = ws.receive_json()
            assert transcription["type"] == "transcription"

            p_state = ws.receive_json()
            assert p_state["state"] == "PROCESSING"

            # While LLM is actively processing in background task, send ping frames
            ws.send_json({"type": "ping"})
            pong1 = ws.receive_json()
            assert pong1["type"] == "pong"

            ws.send_json({"type": "ping"})
            pong2 = ws.receive_json()
            assert pong2["type"] == "pong"

            # Verify chat_response eventually arrives after background processing completes
            chat_res = ws.receive_json()
            assert chat_res["type"] == "chat_response"
            assert chat_res["reply"] == "Story completed."

            speaking = ws.receive_json()
            assert speaking["state"] == "SPEAKING"


def test_voice_websocket_emergency_stop_cancels_active_processing_task():
    """Verify emergency stop safely cancels in-flight turn processing and prevents stale speech."""
    mock_vs, mock_chat_res = _get_mock_voice_services()

    async def slow_chat(*args, **kwargs):
        await asyncio.sleep(0.5)
        return mock_chat_res

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", side_effect=slow_chat), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # WAKE_LISTENING

            ws.send_bytes(bytes(2560))
            ws.receive_json()  # wake_detected
            ws.receive_json()  # RECORDING

            speech_frame = _make_speech_frame(rms=700.0)
            for _ in range(4):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            assert ws.receive_json()["state"] == "TRANSCRIBING"
            assert ws.receive_json()["type"] == "transcription"
            assert ws.receive_json()["state"] == "PROCESSING"

            # Trigger emergency stop while in PROCESSING
            ws.send_json({"type": "emergency_stop"})
            stopped_state = ws.receive_json()
            assert stopped_state == {
                "type": "state_change",
                "state": "WAKE_LISTENING",
                "message": "Stopped. Listening for 'Hey Jarvis'.",
                "follow_up": False,
                "turn_id": 2,
            }

            # Wait to ensure the cancelled background task never emits chat_response or SPEAKING
            time.sleep(0.2)
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            assert pong["type"] == "pong"


def test_voice_websocket_tts_completed_handshake_with_turn_id():
    """Verify TTS completed handshake includes turn_id and returns matching acknowledgement."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # WAKE_LISTENING
            chat_res, speaking = _simulate_voice_turn(ws)

            turn_id = chat_res.get("turn_id")
            assert turn_id is not None
            assert speaking["state"] == "SPEAKING"

            # Send acknowledged tts_completed with turn_id
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            res = ws.receive_json()
            assert res["type"] == "state_change"
            assert res["state"] == "WAKE_LISTENING"
            assert res["ack"] == "tts_completed"
            assert res["turn_id"] == turn_id


def test_voice_websocket_tts_completed_stale_and_duplicate_idempotency():
    """Verify stale tts_completed messages are ignored, and duplicates are handled idempotently."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            active_turn = chat_res["turn_id"]

            # 1. Send stale turn_id (e.g. 999) while in SPEAKING
            ws.send_json({"type": "tts_completed", "turn_id": 999})
            # Verify socket is still responsive and still in SPEAKING by sending ping
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            assert pong["type"] == "pong"

            # 2. Send valid turn_id
            ws.send_json({"type": "tts_completed", "turn_id": active_turn})
            ack1 = ws.receive_json()
            assert ack1["ack"] == "tts_completed"
            assert ack1["turn_id"] == active_turn
            assert ack1["state"] == "WAKE_LISTENING"

            # 3. Send duplicate tts_completed with same turn_id
            ws.send_json({"type": "tts_completed", "turn_id": active_turn})
            ack2 = ws.receive_json()
            assert ack2["ack"] == "tts_completed"
            assert ack2["turn_id"] == active_turn
            assert ack2["state"] == "WAKE_LISTENING"


def test_voice_websocket_pcm_dropped_during_processing_and_speaking():
    """Verify binary PCM is ignored during TRANSCRIBING, PROCESSING, and SPEAKING."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, speaking = _simulate_voice_turn(ws)
            assert speaking["state"] == "SPEAKING"

            # Flood PCM frames during SPEAKING
            for _ in range(10):
                ws.send_bytes(bytes(2560))

            # Send ping to verify socket remains healthy and PCM frames were simply dropped
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            assert pong["type"] == "pong"


def test_voice_websocket_get_state_resync_non_destructive():
    """Verify get_state returns authoritative state and turn_id without mutating active turn."""
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
        init = ws.receive_json()
        assert init["state"] == "WAKE_LISTENING"

        # Query state on standby
        ws.send_json({"type": "get_state"})
        res = ws.receive_json()
        assert res["type"] == "state_change"
        assert res["state"] == "WAKE_LISTENING"
        assert res["turn_id"] == 0


def test_audio_validation_helpers():
    """Verify compute_pcm_rms, is_valid_transcript, is_exit_command, and validate_audio_recording."""
    from backend.services.voice_service import (
        compute_pcm_rms,
        is_valid_transcript,
        is_exit_command,
        validate_audio_recording,
    )
    import numpy as np

    # RMS calculation
    assert compute_pcm_rms(b"") == 0.0
    silence = bytes(960)
    assert compute_pcm_rms(silence) == 0.0

    loud_pcm = (np.ones(480, dtype=np.int16) * 1000).tobytes()
    assert compute_pcm_rms(loud_pcm) == 1000.0

    # Transcript validation
    assert not is_valid_transcript("")
    assert not is_valid_transcript("   ")
    assert not is_valid_transcript("...")
    assert not is_valid_transcript(".......")
    assert not is_valid_transcript(".")
    assert not is_valid_transcript(",")
    assert not is_valid_transcript("[music]")
    assert not is_valid_transcript("(silence)")
    assert is_valid_transcript("hello")
    assert is_valid_transcript("What is the weather?")
    assert is_valid_transcript("123")

    # Exit commands
    assert is_exit_command("Thank you")
    assert is_exit_command("thank you.")
    assert is_exit_command("thanks")
    assert is_exit_command("That's it")
    assert is_exit_command("thats it")
    assert is_exit_command("That's all")
    assert is_exit_command("thats all")
    assert is_exit_command("that is all")
    assert is_exit_command("that is it")
    assert is_exit_command("Bye")
    assert is_exit_command("goodbye")
    assert is_exit_command("good bye")
    assert is_exit_command("stop")
    assert is_exit_command("Go to standby")
    assert is_exit_command("standby")
    assert is_exit_command("sleep")
    assert is_exit_command("jarvis stop")
    assert is_exit_command("stop jarvis")
    assert is_exit_command("ok thank you")

    # Non-exit commands must NOT trigger exit
    assert not is_exit_command("Please don't stop explaining")
    assert not is_exit_command("Stop the timer")
    assert not is_exit_command("Why did you sleep")
    assert not is_exit_command("Say goodbye to everyone")
    assert not is_exit_command("Thank you for your help")

    # Audio recording validation
    assert not validate_audio_recording(b"", 0)[0]
    assert not validate_audio_recording(silence, 5)[0]  # duration too short
    long_silence = bytes(960 * 10)  # 300ms of zeros
    assert not validate_audio_recording(long_silence, 0)[0]  # insufficient speech frames
    assert not validate_audio_recording(long_silence, 5)[0]  # RMS is 0.0 < 180.0

    speech_pcm = _make_speech_frame(rms=500.0) * 5
    assert validate_audio_recording(speech_pcm, 5)[0]


def test_voice_websocket_audio_validation_rejection_on_silence():
    """Verify silence frames during RECORDING are rejected before STT/LLM and cleanly return to standby."""
    mock_vs = MagicMock()
    mock_vs.predict_wake_word.return_value = (True, 0.95)
    mock_vs.is_speech_frame.return_value = False
    mock_vs.transcribe_pcm = AsyncMock()

    mock_chat = AsyncMock()

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.MAX_RECORDING_SECONDS", 0.1), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", mock_chat), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # WAKE_LISTENING

            # Wake word
            ws.send_bytes(bytes(2560))
            assert ws.receive_json()["type"] == "wake_detected"
            assert ws.receive_json()["state"] == "RECORDING"

            # Send silence frames until MAX_RECORDING_SECONDS fires
            for _ in range(5):
                ws.send_bytes(bytes(960))
            time.sleep(0.12)
            ws.send_bytes(bytes(960))

            # Must receive empty_speech event, NOT transcribing
            empty_event = ws.receive_json()
            assert empty_event["type"] == "empty_speech"

            # Must return to WAKE_LISTENING
            standby_event = ws.receive_json()
            assert standby_event["type"] == "state_change"
            assert standby_event["state"] == "WAKE_LISTENING"

            # STT and LLM must NEVER have been called!
            mock_vs.transcribe_pcm.assert_not_called()
            mock_chat.assert_not_called()


def test_voice_websocket_transcript_validation_rejection_on_hallucination():
    """Verify invalid transcripts (e.g. Whisper hallucinating '...') are rejected without LLM invocation."""
    mock_vs = MagicMock()
    mock_vs.predict_wake_word.return_value = (True, 0.95)
    mock_vs.is_speech_frame.side_effect = [True, True, True, True] + [False] * 20
    # Whisper hallucination
    mock_vs.transcribe_pcm = AsyncMock(return_value=("...", 25.0))

    mock_chat = AsyncMock()

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", mock_chat), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # WAKE_LISTENING

            # Wake word
            ws.send_bytes(bytes(2560))
            ws.receive_json()  # wake_detected
            ws.receive_json()  # RECORDING

            speech_frame = _make_speech_frame(rms=700.0)
            for _ in range(4):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            # Transcribing state emitted
            assert ws.receive_json()["state"] == "TRANSCRIBING"

            # STT returned '...', which should be rejected
            empty_event = ws.receive_json()
            assert empty_event["type"] == "empty_speech"

            standby_event = ws.receive_json()
            assert standby_event["state"] == "WAKE_LISTENING"

            # LLM must NEVER be called
            mock_chat.assert_not_called()


def test_voice_websocket_exit_command_returns_to_standby_without_llm():
    """Verify explicit voice exit commands (e.g. 'Thank you', 'Stop') transition directly to standby without LLM."""
    mock_vs = MagicMock()
    mock_vs.predict_wake_word.return_value = (True, 0.95)
    mock_vs.is_speech_frame.side_effect = [True, True, True, True] + [False] * 20
    mock_vs.transcribe_pcm = AsyncMock(return_value=("Thank you.", 30.0))

    mock_chat = AsyncMock()

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", mock_chat), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # WAKE_LISTENING

            # Wake word + speech
            ws.send_bytes(bytes(2560))
            ws.receive_json()  # wake_detected
            ws.receive_json()  # RECORDING

            speech_frame = _make_speech_frame(rms=700.0)
            for _ in range(4):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            assert ws.receive_json()["state"] == "TRANSCRIBING"

            # Transcription event is emitted
            tr = ws.receive_json()
            assert tr["type"] == "transcription"
            assert tr["text"] == "Thank you."

            # Immediately transitions to WAKE_LISTENING without PROCESSING or LLM
            standby = ws.receive_json()
            assert standby["type"] == "state_change"
            assert standby["state"] == "WAKE_LISTENING"
            assert "Standing by" in standby["message"]

            mock_chat.assert_not_called()


def test_voice_websocket_follow_up_window_timeout_returns_to_standby():
    """Verify follow-up window arms after tts_completed and expires to standby after 5 seconds."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 0.15), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_id = chat_res["turn_id"]

            # TTS completed triggers follow-up mode
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            follow_up_state = ws.receive_json()
            assert follow_up_state["state"] == "WAKE_LISTENING"
            assert follow_up_state["follow_up"] is True
            assert "Listening for follow-up" in follow_up_state["message"]

            # Wait for the follow-up timer (patched to 0.15s) to expire
            time.sleep(0.2)
            expired_state = ws.receive_json()
            assert expired_state["type"] == "state_change"
            assert expired_state["state"] == "WAKE_LISTENING"
            assert expired_state["follow_up"] is False
            assert "Listening for 'Hey Jarvis'" in expired_state["message"]


def test_voice_websocket_follow_up_speech_triggers_new_command_without_wake_word():
    """Verify direct speech during follow-up window cancels timer and triggers RECORDING without saying Hey Jarvis."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    # Turn 1: 4 speech + 1 silence; Turn 2 (follow-up): 4 speech + silence
    mock_vs.is_speech_frame.side_effect = (
        [True, True, True, True, False] +
        [True, True, True, True] +
        [False] * 50
    )
    mock_vs.transcribe_pcm = AsyncMock(side_effect=[
        ("hello jarvis", 45.0),
        ("What time is it?", 40.0),
    ])

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 2.0), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_id = chat_res["turn_id"]

            # TTS completed triggers follow-up mode
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            follow_up_state = ws.receive_json()
            assert follow_up_state["follow_up"] is True

            # In follow-up mode, user speaks directly WITHOUT wake word
            speech_frame = _make_speech_frame(rms=700.0)
            ws.send_bytes(speech_frame)
            ws.send_bytes(speech_frame)

            # Direct speech cancels timer and transitions to RECORDING!
            rec_state = ws.receive_json()
            assert rec_state["type"] == "state_change"
            assert rec_state["state"] == "RECORDING"

            # Complete the speech recording for the follow-up turn
            for _ in range(2):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            assert ws.receive_json()["state"] == "TRANSCRIBING"
            tr = ws.receive_json()
            assert tr["type"] == "transcription"
            assert tr["text"] == "What time is it?"
            assert ws.receive_json()["state"] == "PROCESSING"
            follow_up_chat = ws.receive_json()
            assert follow_up_chat["type"] == "chat_response"
            assert ws.receive_json()["state"] == "SPEAKING"


def test_voice_websocket_openwakeword_suppressed_during_follow_up():
    """Verify OpenWakeWord is strictly suppressed during follow-up mode; only VAD runs."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    mock_vs.is_speech_frame.return_value = False
    mock_vs.predict_wake_word.return_value = (True, 0.99)

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 1.0), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_id = chat_res["turn_id"]

            # TTS completed triggers follow-up mode
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            follow_up_state = ws.receive_json()
            assert follow_up_state["follow_up"] is True

            # Snapshot wake word call count
            initial_wake_calls = mock_vs.predict_wake_word.call_count

            # Send multiple wake-word sized frames (2560 bytes)
            for _ in range(5):
                ws.send_bytes(bytes(2560))

            # Verify OpenWakeWord was NEVER called during follow-up
            assert mock_vs.predict_wake_word.call_count == initial_wake_calls

            # Verify state is still WAKE_LISTENING with follow_up=True
            ws.send_json({"type": "get_state"})
            state_res = ws.receive_json()
            assert state_res["state"] == "WAKE_LISTENING"
            assert state_res["follow_up"] is True


def test_rms_validation_quiet_speech_and_noise_filtering():
    """Verify quiet genuine speech with trailing silence passes RMS validation, while noise/silence fails."""
    from backend.services.voice_service import validate_audio_recording, is_valid_transcript

    trailing_silence = bytes(960 * 40)  # 1.2s silence

    # 1. Quiet genuine speech (RMS 220, >= 180 threshold).
    # Whole buffer RMS would be ~66 without speech-frame extraction!
    quiet_speech = _make_speech_frame(rms=220.0) * 4
    full_audio = quiet_speech + trailing_silence
    is_valid, msg = validate_audio_recording(
        full_audio,
        speech_frames=4,
        min_speech_frames=4,
        min_rms=180.0,
        speech_pcm_bytes=quiet_speech,
    )
    assert is_valid is True
    assert msg == "Valid speech audio."

    # 2. Low-energy noise (RMS 60 < 180)
    noise = _make_speech_frame(rms=60.0) * 4
    is_valid, msg = validate_audio_recording(
        noise + trailing_silence,
        speech_frames=4,
        min_speech_frames=4,
        min_rms=180.0,
        speech_pcm_bytes=noise,
    )
    assert is_valid is False
    assert "below threshold" in msg

    # 3. Pure silence
    silence = bytes(960 * 4)
    is_valid, msg = validate_audio_recording(
        silence + trailing_silence,
        speech_frames=4,
        min_speech_frames=4,
        min_rms=180.0,
        speech_pcm_bytes=silence,
    )
    assert is_valid is False
    assert "below threshold" in msg

    # 4. Hallucinations and punctuation-only transcripts
    assert not is_valid_transcript("...")
    assert not is_valid_transcript("  !?.  ")
    assert not is_valid_transcript("")
    assert is_valid_transcript("Hello Jarvis")


def test_voice_websocket_follow_up_invalid_audio_preserves_deadline():
    """Verify invalid audio during follow-up preserves remaining deadline instead of extending or cancelling it."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    mock_vs.is_speech_frame.side_effect = (
        [True, True, True, True, False] +  # Turn 1
        [True, True] + [False] * 50        # Follow-up: 2 frames speech (triggers recording), then silence
    )

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 0.4), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_id = chat_res["turn_id"]

            # TTS completed arms follow-up (0.4s)
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            follow_up_state = ws.receive_json()
            assert follow_up_state["follow_up"] is True

            # Send 2 speech frames to trigger recording
            speech_frame = _make_speech_frame(rms=700.0)
            ws.send_bytes(speech_frame)
            ws.send_bytes(speech_frame)
            assert ws.receive_json()["state"] == "RECORDING"

            # End candidate speech with silence (total speech frames = 2 < 4 min_speech_frames)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            # Must receive empty_speech
            empty_event = ws.receive_json()
            assert empty_event["type"] == "empty_speech"

            # Deadline had ~0.4 - ~0.1 = ~0.3s remaining -> resumed follow-up
            resumed_state = ws.receive_json()
            assert resumed_state["state"] == "WAKE_LISTENING"
            assert resumed_state["follow_up"] is True

            # Wait for remaining deadline to expire
            time.sleep(0.4)
            expired_state = ws.receive_json()
            assert expired_state["state"] == "WAKE_LISTENING"
            assert expired_state["follow_up"] is False
            assert "Listening for 'Hey Jarvis'" in expired_state["message"]


def test_voice_websocket_follow_up_invalid_transcript_preserves_deadline():
    """Verify invalid transcript (e.g. Whisper '...') during follow-up preserves remaining deadline."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    mock_vs.is_speech_frame.side_effect = (
        [True, True, True, True, False] +  # Turn 1
        [True, True, True, True] + [False] * 50  # Follow-up: 4 frames speech, then silence
    )
    mock_vs.transcribe_pcm = AsyncMock(side_effect=[
        ("hello jarvis", 45.0),
        ("...", 30.0),  # Follow-up hallucination
    ])

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 0.4), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_id = chat_res["turn_id"]

            # TTS completed arms follow-up (0.4s)
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            follow_up_state = ws.receive_json()
            assert follow_up_state["follow_up"] is True

            # Send 4 speech frames
            speech_frame = _make_speech_frame(rms=700.0)
            ws.send_bytes(speech_frame)
            ws.send_bytes(speech_frame)
            assert ws.receive_json()["state"] == "RECORDING"

            ws.send_bytes(speech_frame)
            ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            assert ws.receive_json()["state"] == "TRANSCRIBING"

            # Must receive empty_speech due to "..."
            empty_event = ws.receive_json()
            assert empty_event["type"] == "empty_speech"

            # Deadline had remaining time -> resumed follow-up
            resumed_state = ws.receive_json()
            assert resumed_state["state"] == "WAKE_LISTENING"
            assert resumed_state["follow_up"] is True

            # Wait for remaining deadline to expire
            time.sleep(0.4)
            expired_state = ws.receive_json()
            assert expired_state["state"] == "WAKE_LISTENING"
            assert expired_state["follow_up"] is False
            assert "Listening for 'Hey Jarvis'" in expired_state["message"]


def test_voice_websocket_duplicate_tts_acknowledgement_preserves_original_deadline():
    """Verify duplicate tts_completed preserves original deadline and does not extend it."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 0.4), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_id = chat_res["turn_id"]

            # 1. First acknowledgement establishes the 0.4s deadline
            t0 = time.monotonic()
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            ack1 = ws.receive_json()
            assert ack1["ack"] == "tts_completed"
            assert ack1["turn_id"] == turn_id
            assert ack1["follow_up"] is True

            # 2. Duplicate acknowledgement arrives ~0.15s later
            time.sleep(0.15)
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            ack2 = ws.receive_json()
            assert ack2["ack"] == "tts_completed"
            assert ack2["turn_id"] == turn_id
            assert ack2["follow_up"] is True

            # 3. If deadline was preserved, total time to expiration is 0.4s from t0.
            # (If it had been reset, expiration would take 0.15 + 0.4 = 0.55s from t0).
            # Wait remaining time to reach ~0.45s total:
            time.sleep(0.30)
            expired = ws.receive_json()
            t_expired = time.monotonic()
            assert expired["state"] == "WAKE_LISTENING"
            assert expired["follow_up"] is False
            assert "Listening for 'Hey Jarvis'" in expired["message"]

            # Confirm expired close to the original 0.4s window, NOT extended to 0.55s+
            elapsed = t_expired - t0
            assert elapsed < 0.55


def test_voice_websocket_duplicate_acknowledgement_cannot_extend_expired_deadline():
    """Verify duplicate tts_completed after expiration cannot reopen follow-up window."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 0.15), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_id = chat_res["turn_id"]

            # First acknowledgement establishes 0.15s follow-up window
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            ack1 = ws.receive_json()
            assert ack1["follow_up"] is True

            # Wait for expiration
            time.sleep(0.20)
            expired = ws.receive_json()
            assert expired["follow_up"] is False

            # Send duplicate acknowledgement for the expired turn
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            ack2 = ws.receive_json()
            assert ack2["ack"] == "tts_completed"
            assert ack2["turn_id"] == turn_id
            assert ack2["follow_up"] is False
            assert "Listening for 'Hey Jarvis'" in ack2["message"]

            # Check state: still not in follow-up
            ws.send_json({"type": "get_state"})
            state = ws.receive_json()
            assert state["state"] == "WAKE_LISTENING"
            assert state["follow_up"] is False


def test_voice_websocket_stale_turn_acknowledgement_cannot_modify_active_deadline():
    """Verify stale turn_id in tts_completed is ignored and cannot affect active follow-up deadline."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 0.3), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            active_turn = chat_res["turn_id"]

            # Arm follow-up
            ws.send_json({"type": "tts_completed", "turn_id": active_turn})
            ack = ws.receive_json()
            assert ack["follow_up"] is True

            # Send stale turn acknowledgement
            ws.send_json({"type": "tts_completed", "turn_id": 999})

            # Verify active follow-up window is still intact
            ws.send_json({"type": "get_state"})
            res = ws.receive_json()
            assert res["state"] == "WAKE_LISTENING"
            assert res["follow_up"] is True
            assert res["turn_id"] == active_turn

            # Window still expires naturally according to original deadline
            time.sleep(0.35)
            expired = ws.receive_json()
            assert expired["follow_up"] is False


def test_voice_websocket_new_turn_establishes_fresh_deadline():
    """Verify genuinely new turn establishes a fresh 5s deadline."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    mock_vs.is_speech_frame.side_effect = (
        [True, True, True, True, False] +  # Turn 1
        [True, True, True, True, False] +  # Turn 2
        [False] * 50
    )
    mock_vs.transcribe_pcm = AsyncMock(side_effect=[
        ("hello jarvis", 45.0),
        ("Turn two command", 40.0),
    ])

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 0.3), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res1, _ = _simulate_voice_turn(ws)
            turn_1 = chat_res1["turn_id"]

            # Turn 1 acknowledgement
            ws.send_json({"type": "tts_completed", "turn_id": turn_1})
            ack1 = ws.receive_json()
            assert ack1["turn_id"] == turn_1
            assert ack1["follow_up"] is True

            # Start Turn 2 via follow-up direct speech
            speech_frame = _make_speech_frame(rms=700.0)
            ws.send_bytes(speech_frame)
            ws.send_bytes(speech_frame)
            assert ws.receive_json()["state"] == "RECORDING"

            for _ in range(2):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            assert ws.receive_json()["state"] == "TRANSCRIBING"
            assert ws.receive_json()["text"] == "Turn two command"
            assert ws.receive_json()["state"] == "PROCESSING"
            chat_res2 = ws.receive_json()
            assert ws.receive_json()["state"] == "SPEAKING"

            turn_2 = chat_res2["turn_id"]
            assert turn_2 != turn_1

            # First acknowledgement for Turn 2 establishes a brand new fresh deadline!
            ws.send_json({"type": "tts_completed", "turn_id": turn_2})
            ack2 = ws.receive_json()
            assert ack2["ack"] == "tts_completed"
            assert ack2["turn_id"] == turn_2
            assert ack2["follow_up"] is True

            # Window expires after Turn 2's fresh deadline
            time.sleep(0.35)
            expired = ws.receive_json()
            assert expired["follow_up"] is False


def test_voice_websocket_duplicate_ack_during_recording_preserves_buffers_and_state():
    """Verify duplicate tts_completed during follow-up RECORDING preserves audio buffers and state."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    mock_vs.is_speech_frame.side_effect = (
        [True, True, True, True, False] +  # Turn 1
        [True, True, True, True] + [False] * 50  # Follow-up: 4 speech frames, then silence
    )
    mock_vs.transcribe_pcm = AsyncMock(side_effect=[
        ("hello jarvis", 45.0),
        ("Follow up command", 40.0),
    ])

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 2.0), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_1 = chat_res["turn_id"]

            # First acknowledgement establishes follow-up window
            ws.send_json({"type": "tts_completed", "turn_id": turn_1})
            ack1 = ws.receive_json()
            assert ack1["follow_up"] is True

            # Start speaking in follow-up mode (2 frames enter RECORDING)
            speech_frame = _make_speech_frame(rms=700.0)
            ws.send_bytes(speech_frame)
            ws.send_bytes(speech_frame)
            assert ws.receive_json()["state"] == "RECORDING"

            # DELAYED DUPLICATE ACK ARRIVES WHILE RECORDING IS ACTIVE:
            ws.send_json({"type": "tts_completed", "turn_id": turn_1})
            ack_during_rec = ws.receive_json()
            assert ack_during_rec["ack"] == "tts_completed"
            assert ack_during_rec["turn_id"] == turn_1
            assert ack_during_rec["state"] == "RECORDING"

            # Continue speaking: send remaining speech frames + trailing silence
            for _ in range(2):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            # Audio buffers must NOT have been wiped; recording completes to TRANSCRIBING
            assert ws.receive_json()["state"] == "TRANSCRIBING"
            tr = ws.receive_json()
            assert tr["type"] == "transcription"
            assert tr["text"] == "Follow up command"
            assert ws.receive_json()["state"] == "PROCESSING"
            follow_up_chat = ws.receive_json()
            assert follow_up_chat["type"] == "chat_response"
            assert ws.receive_json()["state"] == "SPEAKING"


def test_voice_websocket_duplicate_ack_during_transcribing_preserves_state():
    """Verify duplicate tts_completed during TRANSCRIBING does not disrupt state or STT."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    mock_vs.is_speech_frame.side_effect = (
        [True, True, True, True, False] +  # Turn 1
        [True, True, True, True] + [False] * 50
    )

    call_count = 0
    async def slow_transcribe(audio_bytes):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return ("hello jarvis", 45.0)
        await asyncio.sleep(0.08)
        return ("Transcribed text", 50.0)

    mock_vs.transcribe_pcm = slow_transcribe

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 2.0), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_1 = chat_res["turn_id"]

            ws.send_json({"type": "tts_completed", "turn_id": turn_1})
            assert ws.receive_json()["follow_up"] is True

            # Speech in follow-up
            speech_frame = _make_speech_frame(rms=700.0)
            for _ in range(4):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            # Transitions to RECORDING then TRANSCRIBING
            assert ws.receive_json()["state"] == "RECORDING"
            assert ws.receive_json()["state"] == "TRANSCRIBING"

            # 1. Delayed duplicate ACK for prior turn 1 arrives during TRANSCRIBING of turn 2:
            # Stale turn_id is rejected without interrupting STT or sending an incorrect state change
            ws.send_json({"type": "tts_completed", "turn_id": turn_1})

            # 2. Duplicate ACK matching current_turn_id (turn 2) arrives during TRANSCRIBING:
            # Acknowledges current state without mutating buffers or disrupting STT
            ws.send_json({"type": "tts_completed", "turn_id": 2})
            ack_tr = ws.receive_json()
            assert ack_tr["ack"] == "tts_completed"
            assert ack_tr["turn_id"] == 2
            assert ack_tr["state"] == "TRANSCRIBING"

            # STT finishes and proceeds to PROCESSING and SPEAKING
            tr = ws.receive_json()
            assert tr["type"] == "transcription"
            assert ws.receive_json()["state"] == "PROCESSING"
            assert ws.receive_json()["type"] == "chat_response"
            assert ws.receive_json()["state"] == "SPEAKING"


def test_voice_websocket_duplicate_ack_during_processing_preserves_processing_task():
    """Verify duplicate tts_completed during PROCESSING does not disrupt background LLM processing."""
    mock_vs, mock_chat_res = _get_mock_voice_services()

    async def slow_process(*args, **kwargs):
        await asyncio.sleep(0.12)
        return mock_chat_res

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", side_effect=slow_process), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # Handshake

            # Wake + command recording
            ws.send_bytes(bytes(2560))
            ws.receive_json()  # wake_detected
            ws.receive_json()  # RECORDING

            speech_frame = _make_speech_frame(rms=700.0)
            for _ in range(4):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            assert ws.receive_json()["state"] == "TRANSCRIBING"
            assert ws.receive_json()["type"] == "transcription"
            proc_state = ws.receive_json()
            assert proc_state["state"] == "PROCESSING"

            # Duplicate tts_completed arrives during active PROCESSING
            ws.send_json({"type": "tts_completed", "turn_id": 1})
            ack_proc = ws.receive_json()
            assert ack_proc["ack"] == "tts_completed"
            assert ack_proc["state"] == "PROCESSING"

            # Processing task completes naturally without interference
            chat_response = ws.receive_json()
            assert chat_response["type"] == "chat_response"
            assert ws.receive_json()["state"] == "SPEAKING"


def test_voice_websocket_duplicate_ack_after_expiry_does_not_disrupt_standby_recording():
    """Verify duplicate tts_completed after follow-up expiry cannot disrupt a new wake-triggered RECORDING."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    mock_vs.is_speech_frame.side_effect = (
        [True, True, True, True, False] +  # Turn 1
        [True, True, True, True, False] +  # Turn 2
        [False] * 50
    )
    mock_vs.transcribe_pcm = AsyncMock(side_effect=[
        ("hello jarvis", 45.0),
        ("Standby new command", 40.0),
    ])

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 0.15), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_1 = chat_res["turn_id"]

            # First ACK starts follow-up (0.15s)
            ws.send_json({"type": "tts_completed", "turn_id": turn_1})
            assert ws.receive_json()["follow_up"] is True

            # Wait for follow-up to expire back to standby
            time.sleep(0.20)
            expired = ws.receive_json()
            assert expired["follow_up"] is False

            # In standby, user says "Hey Jarvis" (wake word triggers)
            ws.send_bytes(bytes(2560))
            assert ws.receive_json()["type"] == "wake_detected"
            assert ws.receive_json()["state"] == "RECORDING"

            # A late duplicate ACK for turn 1 arrives during this new standby RECORDING!
            ws.send_json({"type": "tts_completed", "turn_id": turn_1})
            ack_rec = ws.receive_json()
            assert ack_rec["ack"] == "tts_completed"
            assert ack_rec["state"] == "RECORDING"

            # Send speech frames for the new command
            speech_frame = _make_speech_frame(rms=700.0)
            for _ in range(4):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            # Must NOT have dropped audio; completes new command
            assert ws.receive_json()["state"] == "TRANSCRIBING"
            tr = ws.receive_json()
            assert tr["text"] == "Standby new command"
            assert ws.receive_json()["state"] == "PROCESSING"
            assert ws.receive_json()["type"] == "chat_response"
            assert ws.receive_json()["state"] == "SPEAKING"


def test_voice_websocket_duplicate_ack_in_muted_cannot_unmute():
    """Verify duplicate tts_completed while in MUTED state cannot unmute the assistant."""
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
        ws.receive_json()  # Handshake

        # Explicitly mute
        ws.send_json({"type": "mute"})
        muted_state = ws.receive_json()
        assert muted_state["state"] == "MUTED"

        # Send duplicate tts_completed with current_turn_id
        ws.send_json({"type": "tts_completed", "turn_id": 1})
        ack_res = ws.receive_json()
        assert ack_res["state"] == "MUTED"
        assert ack_res["message"] == "Microphone muted."
        assert ack_res["ack"] == "tts_completed"

        # Verify assistant is strictly still MUTED
        ws.send_json({"type": "get_state"})
        state_res = ws.receive_json()
        assert state_res["state"] == "MUTED"


def test_voice_websocket_missing_turn_id_rejected_without_state_change():
    """Verify tts_completed with missing or non-integer turn_id is rejected without altering state."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, speaking = _simulate_voice_turn(ws)
            turn_id = chat_res["turn_id"]
            assert speaking["state"] == "SPEAKING"

            # 1. Send tts_completed with missing turn_id
            ws.send_json({"type": "tts_completed"})

            # 2. Send tts_completed with string turn_id
            ws.send_json({"type": "tts_completed", "turn_id": "one"})

            # 3. Send tts_completed with boolean turn_id
            ws.send_json({"type": "tts_completed", "turn_id": True})

            # Verify socket is still responsive and STILL in SPEAKING
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            assert pong["type"] == "pong"

            ws.send_json({"type": "get_state"})
            state_res = ws.receive_json()
            assert state_res["state"] == "SPEAKING"
            assert state_res["turn_id"] == turn_id

            # Now send valid turn_id -> successfully transitions to WAKE_LISTENING with follow-up
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            ack = ws.receive_json()
            assert ack["ack"] == "tts_completed"
            assert ack["turn_id"] == turn_id
            assert ack["state"] == "WAKE_LISTENING"
            assert ack["follow_up"] is True

def test_voice_websocket_legacy_resume_event_cannot_arm_follow_up_or_mutate_state():
    """Verify legacy resume event cannot enter ACK handler, arm follow-up, or mutate state."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 1.0), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, speaking = _simulate_voice_turn(ws)
            turn_id = chat_res["turn_id"]
            assert speaking["state"] == "SPEAKING"

            # 1. Send legacy resume with matching turn_id
            ws.send_json({"type": "resume", "turn_id": turn_id})

            # 2. Send legacy resume without turn_id
            ws.send_json({"type": "resume"})

            # Verify socket remains responsive and assistant remains strictly in SPEAKING
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            assert pong["type"] == "pong"

            ws.send_json({"type": "get_state"})
            state_res = ws.receive_json()
            assert state_res["state"] == "SPEAKING"
            assert state_res["follow_up"] is False
            assert state_res["turn_id"] == turn_id

            # 3. Only the official tts_completed event can transition state and arm follow-up
            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            ack = ws.receive_json()
            assert ack["ack"] == "tts_completed"
            assert ack["turn_id"] == turn_id
            assert ack["state"] == "WAKE_LISTENING"
            assert ack["follow_up"] is True


def test_voice_service_reset_wake_word_clears_model():
    """Verify reset_wake_word calls underlying model reset and predict_wake_word resets on detection."""
    silence_80ms = bytes(2560)
    mock_model = MagicMock()
    mock_model.models = {"hey_jarvis_v0.1": None}
    mock_model.predict.return_value = {"hey_jarvis_v0.1": 0.90}

    with patch("backend.services.voice_service.WhisperModel"), patch(
        "backend.services.voice_service.Model", return_value=mock_model
    ):
        vs = VoiceService()
        vs.reset_wake_word()
        mock_model.reset.assert_called_once()

        mock_model.reset.reset_mock()
        # When wake word is detected, predict_wake_word must automatically invoke reset_wake_word()
        detected, score = vs.predict_wake_word(silence_80ms)
        assert detected is True
        assert score == 0.90
        mock_model.reset.assert_called_once()


def test_voice_websocket_sequence_a_empty_wake_attempt():
    """Sequence A: standby -> wake -> silence (timeout) -> standby without LLM."""
    mock_vs = MagicMock()
    mock_vs.predict_wake_word.return_value = (True, 0.95)
    mock_vs.is_speech_frame.return_value = False
    mock_chat = AsyncMock()

    client = TestClient(app)
    with patch("backend.routers.voice.INITIAL_SPEECH_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", mock_chat), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()  # initial WAKE_LISTENING

            # Wake word triggers
            ws.send_bytes(bytes(2560))
            assert ws.receive_json()["type"] == "wake_detected"
            assert ws.receive_json()["state"] == "RECORDING"

            # User remains silent; send silence frames past INITIAL_SPEECH_TIMEOUT_SECONDS
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            timeout_state = ws.receive_json()
            assert timeout_state["type"] == "state_change"
            assert timeout_state["state"] == "WAKE_LISTENING"
            assert timeout_state["follow_up"] is False
            assert "timeout" in timeout_state["message"].lower()

            mock_chat.assert_not_called()
            mock_vs.reset_wake_word.assert_called()


def test_voice_websocket_sequence_b_normal_follow_up_expiration():
    """Sequence B: standby -> wake -> recording -> answer -> follow-up (5s) -> silence -> standby."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 0.1), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", new_callable=AsyncMock, return_value=mock_chat_res), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res, _ = _simulate_voice_turn(ws)
            turn_id = chat_res["turn_id"]

            ws.send_json({"type": "tts_completed", "turn_id": turn_id})
            ack = ws.receive_json()
            assert ack["follow_up"] is True

            # Expiration
            time.sleep(0.15)
            expired = ws.receive_json()
            assert expired["type"] == "state_change"
            assert expired["state"] == "WAKE_LISTENING"
            assert expired["follow_up"] is False
            assert expired["turn_id"] == turn_id
            mock_vs.reset_wake_word.assert_called()


def test_voice_websocket_sequence_c_and_d_exit_commands():
    """Sequences C & D: standby -> wake -> answer -> follow-up -> exit commands ('Thank you' & 'That's all') -> standby."""
    for phrase in ["Thank you", "That's all"]:
        mock_vs, mock_chat_res = _get_mock_voice_services()
        mock_vs.is_speech_frame.side_effect = (
            [True, True, True, True, False] +  # Turn 1
            [True, True, True, True, False] +  # Turn 2
            [False] * 50
        )
        mock_vs.transcribe_pcm = AsyncMock(side_effect=[
            ("hello jarvis", 45.0),
            (phrase, 30.0),
        ])
        mock_chat = AsyncMock(return_value=mock_chat_res)

        client = TestClient(app)
        with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
             patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 2.0), \
             patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
             patch("backend.routers.voice.ChatService.process_chat", mock_chat), \
             patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
            with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
                ws.receive_json()
                chat_res1, _ = _simulate_voice_turn(ws)
                turn_1 = chat_res1["turn_id"]

                # Arm follow-up
                ws.send_json({"type": "tts_completed", "turn_id": turn_1})
                assert ws.receive_json()["follow_up"] is True

                # User speaks exit command during follow-up
                speech_frame = _make_speech_frame(rms=700.0)
                for _ in range(4):
                    ws.send_bytes(speech_frame)
                time.sleep(0.06)
                ws.send_bytes(bytes(960))

                assert ws.receive_json()["state"] == "RECORDING"
                assert ws.receive_json()["state"] == "TRANSCRIBING"

                tr = ws.receive_json()
                assert tr["type"] == "transcription"
                assert tr["text"] == phrase

                standby = ws.receive_json()
                assert standby["type"] == "state_change"
                assert standby["state"] == "WAKE_LISTENING"
                assert standby["follow_up"] is False
                assert standby["turn_id"] == 2
                assert "Standing by" in standby["message"]

                # LLM must only have been called for Turn 1, NOT for the exit command!
                assert mock_chat.call_count == 1
                mock_vs.reset_wake_word.assert_called()


def test_voice_websocket_sequence_f_false_exit_phrase_continues_to_llm():
    """Sequence F: False exit phrase ('Please don't stop explaining') proceeds to normal LLM processing."""
    mock_vs, mock_chat_res = _get_mock_voice_services()
    mock_vs.is_speech_frame.side_effect = (
        [True, True, True, True, False] +  # Turn 1
        [True, True, True, True, False] +  # Turn 2
        [False] * 50
    )
    mock_vs.transcribe_pcm = AsyncMock(side_effect=[
        ("hello jarvis", 45.0),
        ("Please don't stop explaining", 40.0),
    ])
    mock_chat = AsyncMock(return_value=mock_chat_res)

    client = TestClient(app)
    with patch("backend.routers.voice.SILENCE_TIMEOUT_SECONDS", 0.05), \
         patch("backend.routers.voice.FOLLOW_UP_TIMEOUT_SECONDS", 2.0), \
         patch("backend.routers.voice.get_voice_service", return_value=mock_vs), \
         patch("backend.routers.voice.ChatService.process_chat", mock_chat), \
         patch("backend.routers.voice.get_settings", return_value=Settings(ENABLE_KOKORO_TTS=False)):
        with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
            ws.receive_json()
            chat_res1, _ = _simulate_voice_turn(ws)
            turn_1 = chat_res1["turn_id"]

            ws.send_json({"type": "tts_completed", "turn_id": turn_1})
            assert ws.receive_json()["follow_up"] is True

            speech_frame = _make_speech_frame(rms=700.0)
            for _ in range(4):
                ws.send_bytes(speech_frame)
            time.sleep(0.06)
            ws.send_bytes(bytes(960))

            assert ws.receive_json()["state"] == "RECORDING"
            assert ws.receive_json()["state"] == "TRANSCRIBING"

            tr = ws.receive_json()
            assert tr["type"] == "transcription"
            assert tr["text"] == "Please don't stop explaining"

            # Must proceed to PROCESSING and SPEAKING via LLM
            assert ws.receive_json()["state"] == "PROCESSING"
            res2 = ws.receive_json()
            assert res2["type"] == "chat_response"
            assert ws.receive_json()["state"] == "SPEAKING"
            assert mock_chat.call_count == 2


def test_voice_websocket_concurrent_connection_rejected_with_1008():
    """Verify second concurrent voice WebSocket is rejected with code 1008 and active session continues undisturbed."""
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws1:
        init1 = ws1.receive_json()
        assert init1["state"] == "WAKE_LISTENING"
        assert init1["initial"] is True
        assert init1["turn_id"] == 0

        # Attempt second simultaneous connection
        with pytest.raises(WebSocketDisconnect) as exc_info:
            with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws2:
                ws2.receive_json()

        assert exc_info.value.code == 1008
        assert "Voice session already active" in str(exc_info.value.reason)

        # Active session 1 remains completely undisturbed
        ws1.send_json({"type": "ping"})
        assert ws1.receive_json()["type"] == "pong"


def test_voice_websocket_disconnect_releases_session_guard_allowing_reconnect():
    """Verify normal disconnect releases the session guard and allows subsequent connections."""
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws1:
        init1 = ws1.receive_json()
        assert init1["state"] == "WAKE_LISTENING"
        ws1.send_json({"type": "ping"})
        assert ws1.receive_json()["type"] == "pong"

    # After ws1 exits context, ws2 should connect successfully without 1008 rejection
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws2:
        init2 = ws2.receive_json()
        assert init2["state"] == "WAKE_LISTENING"
        ws2.send_json({"type": "ping"})
        assert ws2.receive_json()["type"] == "pong"


def test_voice_websocket_rejected_cleanup_cannot_release_active_session():
    """Verify rejected connection's cleanup cannot accidentally release the active connection guard."""
    from backend.routers import voice as voice_router

    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws1:
        ws1.receive_json()
        active_socket_ref = voice_router._active_voice_socket
        assert active_socket_ref is not None

        # Rejected connection executes its finally block
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws2:
                ws2.receive_json()

        # Active session guard MUST still belong to ws1
        assert voice_router._active_voice_socket is active_socket_ref

        # A third connection must STILL be rejected
        with pytest.raises(WebSocketDisconnect) as exc_info3:
            with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws3:
                ws3.receive_json()
        assert exc_info3.value.code == 1008

        # ws1 is still alive and responsive
        ws1.send_json({"type": "ping"})
        assert ws1.receive_json()["type"] == "pong"


def test_voice_websocket_all_state_transitions_carry_turn_ids():
    """Verify state transitions carry authoritative turn IDs and initial connection is marked."""
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
        # Initial connection
        init = ws.receive_json()
        assert init["state"] == "WAKE_LISTENING"
        assert init["initial"] is True
        assert init["turn_id"] == 0

        # Mute
        ws.send_json({"type": "mute"})
        muted = ws.receive_json()
        assert muted["state"] == "MUTED"
        assert muted["turn_id"] == 1

        # Unmute
        ws.send_json({"type": "unmute"})
        unmuted = ws.receive_json()
        assert unmuted["state"] == "WAKE_LISTENING"
        assert unmuted["turn_id"] == 2

        # Emergency stop
        ws.send_json({"type": "emergency_stop"})
        stopped = ws.receive_json()
        assert stopped["state"] == "WAKE_LISTENING"
        assert stopped["turn_id"] == 3


def test_voice_websocket_accept_failure_releases_session_reservation():
    """Verify that failure during WebSocket accept releases session reservation."""
    from unittest.mock import AsyncMock
    from backend.routers import voice as voice_router

    mock_ws = AsyncMock()
    mock_ws.accept.side_effect = RuntimeError("Simulated accept failure")

    asyncio.run(voice_router.handle_voice_websocket(mock_ws))

    # Reservation must be released
    assert voice_router._active_voice_socket is None

    # Subsequent connection via TestClient must succeed cleanly
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
        init = ws.receive_json()
        assert init["state"] == "WAKE_LISTENING"
        assert init["turn_id"] == 0


def test_voice_websocket_initial_send_failure_releases_session_reservation():
    """Verify that failure during initial state transmission releases session reservation."""
    from unittest.mock import AsyncMock
    from backend.routers import voice as voice_router

    mock_ws = AsyncMock()
    mock_ws.send_json.side_effect = RuntimeError("Simulated initial send failure")

    asyncio.run(voice_router.handle_voice_websocket(mock_ws))

    # Reservation must be released
    assert voice_router._active_voice_socket is None

    # Subsequent connection via TestClient must succeed cleanly
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as ws:
        init = ws.receive_json()
        assert init["state"] == "WAKE_LISTENING"
        assert init["turn_id"] == 0

