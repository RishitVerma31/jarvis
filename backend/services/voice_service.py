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
import re
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

EXIT_COMMAND_PHRASES = frozenset({
    "thank you",
    "thanks",
    "that's it",
    "thats it",
    "that's all",
    "thats all",
    "that is all",
    "that is it",
    "bye",
    "goodbye",
    "good bye",
    "stop",
    "go to standby",
    "standby",
    "sleep",
})


def compute_pcm_rms(pcm_bytes: bytes) -> float:
    """Calculate the Root-Mean-Square (RMS) amplitude of 16-bit mono PCM audio.

    Args:
        pcm_bytes: 16-bit 16kHz mono PCM byte string.

    Returns:
        float: RMS amplitude level in range [0.0, 32767.0].
    """
    if not pcm_bytes or len(pcm_bytes) < 2:
        return 0.0
    aligned_len = len(pcm_bytes) - (len(pcm_bytes) % 2)
    samples = np.frombuffer(pcm_bytes[:aligned_len], dtype=np.int16)
    if len(samples) == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))


def is_valid_transcript(text: str) -> bool:
    """Validate that transcription contains meaningful alphanumeric content.

    Rejects empty, whitespace-only, and punctuation-only output (e.g. '...', '....', '.', ',').
    """
    if not text or not text.strip():
        return False
    # Strip bracketed whisper tags e.g. [music], (silence)
    cleaned = re.sub(r'\[.*?\]|\(.*?\)', '', text).strip()
    if not cleaned:
        return False
    # Check for at least one alphanumeric character
    alphanumeric = re.sub(r'[\W_]+', '', cleaned, flags=re.UNICODE)
    return len(alphanumeric) > 0


def is_exit_command(text: str) -> bool:
    """Determine whether a transcript matches an explicit voice exit command.

    Supported phrases:
    - 'thank you' / 'thanks'
    - 'that's it' / 'thats it'
    - 'that's all' / 'thats all'
    - 'bye' / 'goodbye' / 'good bye'
    - 'stop'
    - 'go to standby' / 'standby'
    - 'sleep'

    Rules:
    - Normalizes case and punctuation.
    - Requires complete phrase match.
    - Disallows arbitrary substring matches (e.g. 'Please don't stop explaining' is NOT an exit).
    - Allows optional leading/trailing conversational prefixes like 'jarvis stop' or 'ok thank you'.
    """
    if not text:
        return False

    cleaned = re.sub(r"[^\w\s']", '', text.lower()).strip()
    cleaned = re.sub(r'\s+', ' ', cleaned)

    if not cleaned:
        return False

    if cleaned in EXIT_COMMAND_PHRASES:
        return True

    words = cleaned.split()
    if len(words) >= 2:
        # Optional leading address words e.g. "jarvis stop", "ok thank you"
        if words[0] in ("jarvis", "ok", "okay"):
            remainder = " ".join(words[1:])
            if remainder in EXIT_COMMAND_PHRASES:
                return True
        # Optional trailing address word e.g. "stop jarvis", "thank you jarvis"
        if words[-1] in ("jarvis",):
            remainder = " ".join(words[:-1])
            if remainder in EXIT_COMMAND_PHRASES:
                return True

    return False


def validate_audio_recording(
    pcm_bytes: bytes,
    speech_frames: int,
    min_speech_frames: int = 4,
    min_rms: float = 180.0,
    speech_pcm_bytes: bytes | None = None,
) -> tuple[bool, str]:
    """Validate recorded audio before passing to STT and LLM.

    Args:
        pcm_bytes: Complete recorded PCM byte sequence (including trailing silence).
        speech_frames: Number of 30ms frames classified as speech by VAD.
        min_speech_frames: Minimum number of speech frames required (default: 4 frames = 120ms).
        min_rms: Minimum RMS energy threshold required for active speech (default: 180.0).
        speech_pcm_bytes: Optional byte sequence containing only the identified speech frames.
            If omitted or empty, speech frames are extracted using WebRTC VAD from pcm_bytes.

    Returns:
        tuple[bool, str]: (is_valid, reason)
    """
    if not pcm_bytes:
        return False, "Audio buffer is empty."

    duration_sec = (len(pcm_bytes) // 2) / 16000.0
    if duration_sec < 0.12:
        return False, f"Audio duration too short ({duration_sec:.2f}s < 0.12s)."

    if speech_frames < min_speech_frames:
        return False, f"Insufficient speech frames detected by VAD ({speech_frames} < {min_speech_frames})."

    # Calculate RMS over the identified speech frames rather than the whole buffer
    # to avoid energy dilution by trailing silence
    if speech_pcm_bytes and len(speech_pcm_bytes) >= 2:
        speech_rms = compute_pcm_rms(speech_pcm_bytes)
    else:
        # Extract speech frames using WebRTC VAD from pcm_bytes
        try:
            vad = webrtcvad.Vad(2)
            extracted_speech = bytearray()
            # 960 bytes = 30ms at 16kHz mono 16-bit
            for i in range(0, len(pcm_bytes) - (len(pcm_bytes) % 960), 960):
                frame = pcm_bytes[i : i + 960]
                if vad.is_speech(frame, 16000):
                    extracted_speech.extend(frame)
            if len(extracted_speech) >= 2:
                speech_rms = compute_pcm_rms(bytes(extracted_speech))
            else:
                speech_rms = compute_pcm_rms(pcm_bytes)
        except Exception:
            speech_rms = compute_pcm_rms(pcm_bytes)

    if speech_rms < min_rms:
        return False, f"Audio RMS energy below threshold ({speech_rms:.1f} < {min_rms:.1f})."

    return True, "Valid speech audio."


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
