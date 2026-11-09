"""Voice service for PROJECT JARVIS.

Manages openWakeWord wake-word detection, faster-whisper speech-to-text,
and WebRTC Voice Activity Detection (VAD).

Attribution & Model Licensing:
- Pretrained wake-word model 'hey_jarvis_v0.1.onnx' created by David Scripka
  (openWakeWord). Licensed under Creative Commons Attribution-NonCommercial-
  ShareAlike 4.0 International (CC BY-NC-SA 4.0).
- openWakeWord framework code is licensed under Apache 2.0.
"""

import asyncio
import logging
import os
from pathlib import Path
import time
from typing import Any
import urllib.request
import numpy as np
import webrtcvad
from openwakeword.model import Model
import faster_whisper
from faster_whisper import WhisperModel

from backend.config import Settings, get_settings

logger = logging.getLogger("jarvis.voice_service")

# Official openWakeWord model release URLs
OPENWAKEWORD_RELEASE_URL = "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1"
MODEL_FILES = {
    "hey_jarvis_v0.1.onnx": f"{OPENWAKEWORD_RELEASE_URL}/hey_jarvis_v0.1.onnx",
    "melspectrogram.onnx": f"{OPENWAKEWORD_RELEASE_URL}/melspectrogram.onnx",
    "embedding_model.onnx": f"{OPENWAKEWORD_RELEASE_URL}/embedding_model.onnx",
}


def download_model_file(url: str, destination: Path) -> None:
    """Download a model file if not already present."""
    if destination.exists() and destination.stat().st_size > 0:
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    logger.info("Downloading %s to %s...", destination.name, destination)

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Jarvis-VoiceAssistant/1.0"},
    )
    with urllib.request.urlopen(req) as response, open(destination, "wb") as out_file:
        out_file.write(response.read())

    logger.info("Successfully downloaded %s (%d bytes).", destination.name, destination.stat().st_size)


class VoiceService:
    """Coordinates wake-word detection, VAD, and local speech-to-text transcription."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.models_dir = self.settings.resolved_models_path
        self.openwakeword_dir = self.models_dir / "openwakeword"
        self.whisper_dir = self.models_dir / "whisper"

        self.threshold = self.settings.WAKE_WORD_THRESHOLD
        self.cooldown_seconds = self.settings.WAKE_WORD_COOLDOWN_SECONDS
        self.last_wake_time: float = 0.0

        # Ensure directories exist
        self.openwakeword_dir.mkdir(parents=True, exist_ok=True)
        self.whisper_dir.mkdir(parents=True, exist_ok=True)

        # 1. Initialize openWakeWord
        self._init_openwakeword()

        # 2. Initialize WebRTC VAD
        # Mode 2: balance between aggressiveness and sensitivity (0-3)
        self.vad = webrtcvad.Vad(2)

        # 3. Initialize faster-whisper with CUDA auto-detect and CPU fallback
        self._init_faster_whisper()

    def _init_openwakeword(self) -> None:
        """Download (if needed) and initialize openWakeWord models from local paths."""
        for filename, url in MODEL_FILES.items():
            dest = self.openwakeword_dir / filename
            if not dest.exists():
                try:
                    download_model_file(url, dest)
                except Exception as exc:
                    logger.error("Failed to download openWakeWord model %s: %s", filename, exc)
                    raise

        hey_jarvis_path = self.openwakeword_dir / "hey_jarvis_v0.1.onnx"
        melspec_path = self.openwakeword_dir / "melspectrogram.onnx"
        embedding_path = self.openwakeword_dir / "embedding_model.onnx"

        logger.info("Initializing openWakeWord from %s", self.openwakeword_dir)
        self.wakeword_model = Model(
            wakeword_models=[str(hey_jarvis_path)],
            melspec_model_path=str(melspec_path),
            embedding_model_path=str(embedding_path),
            inference_framework="onnx",
        )
        keys = list(self.wakeword_model.models.keys())
        self.wake_model_key = keys[0] if keys else "hey_jarvis_v0.1"
        logger.info("openWakeWord initialized. Active model key: '%s'", self.wake_model_key)

    def _init_faster_whisper(self) -> None:
        """Initialize faster-whisper model with CUDA auto-detection and resilient CPU fallback."""
        model_size = self.settings.WHISPER_MODEL_SIZE
        target_device = self.settings.WHISPER_DEVICE.lower()
        target_compute = self.settings.WHISPER_COMPUTE_TYPE.lower()

        logger.info(
            "Configuring faster-whisper (model=%s, device_setting=%s, compute_setting=%s, root=%s)",
            model_size,
            target_device,
            target_compute,
            self.whisper_dir,
        )

        # Attempt CUDA if requested or set to auto
        cuda_attempted = False
        if target_device in ("auto", "cuda"):
            try:
                compute_type = "float16" if target_compute == "auto" else target_compute
                logger.info("Attempting faster-whisper initialization on CUDA (%s)...", compute_type)
                self.whisper_model = WhisperModel(
                    model_size,
                    device="cuda",
                    compute_type=compute_type,
                    download_root=str(self.whisper_dir),
                )
                self.active_device = "cuda"
                self.active_compute_type = compute_type
                cuda_attempted = True
                logger.info("faster-whisper successfully initialized on NVIDIA CUDA (%s)", compute_type)
                return
            except Exception as exc:
                logger.warning(
                    "CUDA initialization failed (%s); falling back to CPU execution with int8 quantization.",
                    exc,
                )

        # CPU fallback (standard or explicit)
        cpu_compute = "int8" if target_compute == "auto" else target_compute
        logger.info("Initializing faster-whisper on CPU (%s)...", cpu_compute)
        self.whisper_model = WhisperModel(
            model_size,
            device="cpu",
            compute_type=cpu_compute,
            download_root=str(self.whisper_dir),
        )
        self.active_device = "cpu"
        self.active_compute_type = cpu_compute
        logger.info("faster-whisper successfully initialized on CPU (%s)", cpu_compute)

    def predict_wake_word(self, pcm_chunk: bytes) -> tuple[bool, float]:
        """Predict wake-word presence in an 80ms (1280 samples = 2560 bytes) PCM chunk.

        Args:
            pcm_chunk: Exactly 2560 bytes of 16-bit 16kHz mono PCM audio.

        Returns:
            tuple[bool, float]: (is_detected, confidence_score)
        """
        if len(pcm_chunk) != 2560:
            logger.debug("pcm_chunk size %d != 2560 bytes; skipping wake prediction", len(pcm_chunk))
            return False, 0.0

        audio_np = np.frombuffer(pcm_chunk, dtype=np.int16)
        predictions = self.wakeword_model.predict(audio_np)
        score = float(predictions.get(self.wake_model_key, 0.0))

        now = time.monotonic()
        cooldown_elapsed = (now - self.last_wake_time) >= self.cooldown_seconds

        if score >= self.threshold and cooldown_elapsed:
            self.last_wake_time = now
            logger.info("Wake-word detected! Model: '%s', Score: %.3f", self.wake_model_key, score)
            return True, score

        return False, score

    def is_speech_frame(self, pcm_frame: bytes) -> bool:
        """Check voice activity on a 30ms (480 samples = 960 bytes) PCM chunk.

        Args:
            pcm_frame: Exactly 960 bytes of 16-bit 16kHz mono PCM audio.

        Returns:
            bool: True if speech is detected by WebRTC VAD, False otherwise.
        """
        if len(pcm_frame) != 960:
            return False
        return self.vad.is_speech(pcm_frame, 16000)

    async def transcribe_pcm(self, pcm_bytes: bytes) -> tuple[str, float]:
        """Transcribe in-memory 16-bit 16kHz mono PCM audio to text.

        Runs transcription in an async worker thread to prevent blocking FastAPI's event loop.

        Args:
            pcm_bytes: Raw 16-bit 16kHz mono PCM audio bytes.

        Returns:
            tuple[str, float]: (transcribed_text, latency_ms)
        """
        if not pcm_bytes:
            return "", 0.0

        start_time = time.perf_counter()

        def _do_transcription() -> str:
            # Convert 16-bit PCM integer samples to float32 normalized in [-1.0, 1.0]
            audio_np = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            segments, _ = self.whisper_model.transcribe(
                audio_np,
                language="en",
                beam_size=2,
                vad_filter=False,  # We handle VAD externally before calling transcribe
            )
            text_parts = [s.text.strip() for s in segments if s.text and s.text.strip()]
            return " ".join(text_parts).strip()

        transcript = await asyncio.to_thread(_do_transcription)
        latency_ms = (time.perf_counter() - start_time) * 1000.0

        audio_duration_s = (len(pcm_bytes) // 2) / 16000.0
        logger.info(
            "Transcribed %.2fs audio -> '%s' in %.1fms (device=%s, %s)",
            audio_duration_s,
            transcript,
            latency_ms,
            self.active_device,
            self.active_compute_type,
        )

        return transcript, latency_ms


_voice_service_instance: VoiceService | None = None


def get_voice_service(settings: Settings | None = None) -> VoiceService:
    """Return singleton VoiceService instance, initializing on first call."""
    global _voice_service_instance
    if _voice_service_instance is None:
        _voice_service_instance = VoiceService(settings=settings)
    return _voice_service_instance
