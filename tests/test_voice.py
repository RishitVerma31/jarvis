"""Unit and integration tests for VoiceService and Voice WebSocket router."""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi.testclient import TestClient
from backend.main import app
from backend.security import get_ticket_store
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

