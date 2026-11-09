"""Unit and integration tests for VoiceService and Voice WebSocket router."""

import asyncio
import base64
import time
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient
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
    """Verify setting session and handling tts_completed resume."""
    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={get_test_ws_ticket()}") as websocket:
        # Handshake
        websocket.receive_json()

        # Set session
        websocket.send_json({"type": "set_session", "session_id": "test-session-456"})

        # TTS Completed
        websocket.send_json({"type": "tts_completed"})
        res = websocket.receive_json()
        assert res["type"] == "state_change"
        assert res["state"] == "WAKE_LISTENING"


def _simulate_voice_turn(ws, silence_delay: float = 0.06) -> tuple[dict, dict]:
    """Drive a full voice turn through the WebSocket and return (chat_response, speaking_state)."""
    # 1. Send wake word PCM frame (80ms = 2560 bytes)
    ws.send_bytes(bytes(2560))
    wake_event = ws.receive_json()
    assert wake_event["type"] == "wake_detected"

    rec_state = ws.receive_json()
    assert rec_state["type"] == "state_change"
    assert rec_state["state"] == "RECORDING"

    # 2. Send speech PCM frame (30ms = 960 bytes)
    ws.send_bytes(bytes(960))
    time.sleep(silence_delay)
    # Send second frame after silence delay to trigger silence check
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
    mock_vs.is_speech_frame.side_effect = [True, False, False, False]
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
            }

            # Step 2-4: Turn through to SPEAKING
            chat_res, speaking = _simulate_voice_turn(ws)
            assert chat_res["type"] == "chat_response"
            assert "audio" in chat_res
            assert speaking == {
                "type": "state_change",
                "state": "SPEAKING",
                "message": "Speaking response...",
            }

            # Step 5: Client signals TTS completion
            ws.send_json({"type": "tts_completed"})
            resumed_state = ws.receive_json()
            assert resumed_state == {
                "type": "state_change",
                "state": "WAKE_LISTENING",
                "message": "Standing by. Listening for 'Hey Jarvis'.",
            }

            # Step 6: Verify ready for next interaction
            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            assert pong["type"] == "pong"

