"""Tests for Kokoro-82M neural TTS service (Phase 1).

Validates:
1. Text normalization & empty input handling.
2. Missing model/voice file detection and typed exceptions.
3. Kokoro initialization failure handling and recovery.
4. Voice identifier sanitation and security (preventing path traversal).
5. Accurate 24kHz mono 16-bit PCM WAV generation and header parsing.
6. Synthesis failure handling.
7. Concurrent initialization thread/lock safety.
8. Settings configuration and singleton lifecycle.
"""

import asyncio
import io
import wave
from pathlib import Path
from unittest.mock import MagicMock, patch
import numpy as np
import pytest

from backend.config import Settings
from backend.services.kokoro_service import (
    KokoroError,
    KokoroInitializationError,
    KokoroModelNotFoundError,
    KokoroService,
    KokoroSynthesisError,
    get_kokoro_service,
    normalize_text_for_speech,
    reset_kokoro_service,
)


# ==============================================================================
# 1. Text Normalization & Sanitization
# ==============================================================================

def test_normalize_text_strips_markdown_formatting():
    """Verify that Markdown tokens are converted to clean, speakable prose."""
    raw = (
        "# System Status\n\n"
        "Here is the report:\n"
        "```python\ndef run():\n    pass\n```\n"
        "All `services` are running **normally** and *smoothly*.\n"
        "> Quote block\n"
        "Check [our dashboard](https://jarvis.local/stats) for details."
    )
    normalized = normalize_text_for_speech(raw)

    assert "System Status" in normalized
    assert "#" not in normalized
    assert "Code block omitted." in normalized
    assert "def run" not in normalized
    assert "`" not in normalized
    assert "services are running normally and smoothly." in normalized
    assert "*" not in normalized
    assert ">" not in normalized
    assert "Quote block" in normalized
    assert "Check our dashboard for details." in normalized
    assert "https://" not in normalized


def test_normalize_text_empty_and_whitespace():
    """Verify empty or whitespace inputs normalize to empty strings."""
    assert normalize_text_for_speech("") == ""
    assert normalize_text_for_speech("   \n\t  ") == ""
    assert normalize_text_for_speech(None) == ""


# ==============================================================================
# 2. Voice Sanitization & Path Traversal Prevention
# ==============================================================================

def test_validate_voice_accepts_safe_identifiers():
    """Verify valid voice identifiers pass through."""
    service = KokoroService()
    assert service.validate_voice("af_bella") == "af_bella"
    assert service.validate_voice("am_adam") == "am_adam"
    assert service.validate_voice("bf_emma") == "bf_emma"
    assert service.validate_voice("bm_george") == "bm_george"


def test_validate_voice_rejects_path_traversal_and_malformed():
    """Verify path traversal or malformed strings fall back to default voice."""
    service = KokoroService()
    default = service.default_voice

    assert service.validate_voice("../../etc/passwd") == default
    assert service.validate_voice("..\\windows\\system32") == default
    assert service.validate_voice("af_bella; rm -rf /") == default
    assert service.validate_voice("<script>alert(1)</script>") == default
    assert service.validate_voice("!invalid!") == default
    assert service.validate_voice("") == default
    assert service.validate_voice(None) == default


# ==============================================================================
# 3. Missing Model and Voice Files
# ==============================================================================

@pytest.mark.asyncio
async def test_ensure_loaded_raises_on_missing_model_file(tmp_path: Path):
    """Verify KokoroModelNotFoundError is raised if kokoro-v1.0.onnx does not exist."""
    fake_model = tmp_path / "nonexistent_model.onnx"
    fake_voices = tmp_path / "voices.bin"
    fake_voices.write_bytes(b"dummy voices content")

    settings = Settings(
        KOKORO_MODEL_PATH=str(fake_model),
        KOKORO_VOICES_PATH=str(fake_voices),
    )
    service = KokoroService(settings=settings)

    with pytest.raises(KokoroModelNotFoundError) as exc_info:
        await service.ensure_loaded()

    assert "model file not found" in str(exc_info.value).lower()
    assert not service.is_loaded


@pytest.mark.asyncio
async def test_ensure_loaded_raises_on_missing_voices_file(tmp_path: Path):
    """Verify KokoroModelNotFoundError is raised if voices-v1.0.bin does not exist."""
    fake_model = tmp_path / "kokoro-v1.0.onnx"
    fake_model.write_bytes(b"dummy onnx content")
    fake_voices = tmp_path / "nonexistent_voices.bin"

    settings = Settings(
        KOKORO_MODEL_PATH=str(fake_model),
        KOKORO_VOICES_PATH=str(fake_voices),
    )
    service = KokoroService(settings=settings)

    with pytest.raises(KokoroModelNotFoundError) as exc_info:
        await service.ensure_loaded()

    assert "voices file not found" in str(exc_info.value).lower()
    assert not service.is_loaded


# ==============================================================================
# 4. Initialization Failure Handling
# ==============================================================================

@pytest.mark.asyncio
async def test_ensure_loaded_wraps_onnx_runtime_initialization_errors(tmp_path: Path):
    """Verify unexpected ONNX or loading errors raise KokoroInitializationError."""
    fake_model = tmp_path / "model.onnx"
    fake_model.write_bytes(b"invalid onnx data")
    fake_voices = tmp_path / "voices.bin"
    fake_voices.write_bytes(b"invalid voices data")

    settings = Settings(
        KOKORO_MODEL_PATH=str(fake_model),
        KOKORO_VOICES_PATH=str(fake_voices),
    )
    service = KokoroService(settings=settings)

    with patch("backend.services.kokoro_service.Kokoro", side_effect=RuntimeError("Corrupt ONNX graph")):
        with pytest.raises(KokoroInitializationError) as exc_info:
            await service.ensure_loaded()

    assert "initialization failed" in str(exc_info.value).lower()
    assert not service.is_loaded


# ==============================================================================
# 5. Concurrent Initialization Safety
# ==============================================================================

@pytest.mark.asyncio
async def test_concurrent_ensure_loaded_calls_kokoro_constructor_once(tmp_path: Path):
    """Verify that multiple concurrent calls to ensure_loaded only initialize Kokoro once."""
    fake_model = tmp_path / "model.onnx"
    fake_model.write_bytes(b"data")
    fake_voices = tmp_path / "voices.bin"
    fake_voices.write_bytes(b"data")

    settings = Settings(
        KOKORO_MODEL_PATH=str(fake_model),
        KOKORO_VOICES_PATH=str(fake_voices),
    )
    service = KokoroService(settings=settings)

    init_call_count = 0

    class MockKokoroInstance:
        def __init__(self, *args, **kwargs):
            nonlocal init_call_count
            init_call_count += 1

    with patch("backend.services.kokoro_service.Kokoro", side_effect=MockKokoroInstance):
        # Fire 10 concurrent initialization requests
        tasks = [service.ensure_loaded() for _ in range(10)]
        await asyncio.gather(*tasks)

    assert init_call_count == 1, f"Expected exactly 1 initialization, got {init_call_count}"
    assert service.is_loaded


# ==============================================================================
# 6. Audio Generation, WAV Header & Sample-Rate Validation
# ==============================================================================

@pytest.mark.asyncio
async def test_synthesize_produces_valid_24k_16bit_mono_wav(tmp_path: Path):
    """Verify synthesize produces a compliant 24kHz mono 16-bit PCM WAV."""
    fake_model = tmp_path / "model.onnx"
    fake_model.write_bytes(b"data")
    fake_voices = tmp_path / "voices.bin"
    fake_voices.write_bytes(b"data")

    settings = Settings(
        KOKORO_MODEL_PATH=str(fake_model),
        KOKORO_VOICES_PATH=str(fake_voices),
        KOKORO_VOICE="af_bella",
    )
    service = KokoroService(settings=settings)

    # Generate 0.5s of simulated 24kHz audio (12,000 samples)
    sr = 24000
    mock_samples = np.sin(2 * np.pi * 440 * np.linspace(0, 0.5, 12000, dtype=np.float32))

    mock_kokoro = MagicMock()
    mock_kokoro.create.return_value = (mock_samples, sr)

    with patch("backend.services.kokoro_service.Kokoro", return_value=mock_kokoro):
        wav_bytes, latency_ms = await service.synthesize("Greetings sir, all systems online.")

    # 1. Verify latency was measured
    assert latency_ms > 0

    # 2. Verify RIFF / WAVE header magic bytes
    assert wav_bytes.startswith(b"RIFF")
    assert wav_bytes[8:12] == b"WAVE"

    # 3. Parse with standard wave module
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        assert wf.getnchannels() == 1, "Must be mono audio"
        assert wf.getsampwidth() == 2, "Must be 16-bit PCM (2 bytes per sample)"
        assert wf.getframerate() == 24000, "Must be 24000 Hz sample rate"
        assert wf.getnframes() == 12000, "Frame count must match 0.5s at 24kHz"

    # 4. Verify create arguments
    mock_kokoro.create.assert_called_once_with(
        "Greetings sir, all systems online.",
        voice="af_bella",
        speed=1.0,
        lang="en-us",
    )


# ==============================================================================
# 7. Synthesis Error and Empty Input Handling
# ==============================================================================

@pytest.mark.asyncio
async def test_synthesize_raises_value_error_on_empty_text():
    """Verify ValueError is raised if input text has no speakable content."""
    service = KokoroService()
    with pytest.raises(ValueError) as exc_info:
        await service.synthesize("   \n\t  ")

    assert "empty" in str(exc_info.value).lower()


@pytest.mark.asyncio
async def test_synthesize_wraps_inference_errors_in_kokoro_synthesis_error(tmp_path: Path):
    """Verify inference failure raises KokoroSynthesisError."""
    fake_model = tmp_path / "model.onnx"
    fake_model.write_bytes(b"data")
    fake_voices = tmp_path / "voices.bin"
    fake_voices.write_bytes(b"data")

    settings = Settings(
        KOKORO_MODEL_PATH=str(fake_model),
        KOKORO_VOICES_PATH=str(fake_voices),
    )
    service = KokoroService(settings=settings)

    mock_kokoro = MagicMock()
    mock_kokoro.create.side_effect = RuntimeError("ONNX inference crashed")

    with patch("backend.services.kokoro_service.Kokoro", return_value=mock_kokoro):
        with pytest.raises(KokoroSynthesisError) as exc_info:
            await service.synthesize("Hello world")

    assert "synthesis failed" in str(exc_info.value).lower()


# ==============================================================================
# 8. Singleton Lifecycle & Settings Integration
# ==============================================================================

def test_singleton_lifecycle():
    """Verify get_kokoro_service returns singleton and reset_kokoro_service clears it."""
    reset_kokoro_service()
    svc1 = get_kokoro_service()
    svc2 = get_kokoro_service()
    assert svc1 is svc2

    reset_kokoro_service()
    svc3 = get_kokoro_service()
    assert svc3 is not svc1
    reset_kokoro_service()
