"""Kokoro-82M neural text-to-speech service for PROJECT JARVIS.

Generates high-fidelity local speech using kokoro-onnx and standard 24kHz 16-bit PCM WAV.
"""

import asyncio
import io
import logging
import re
import time
from pathlib import Path
from typing import Any
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

from backend.config import Settings, get_settings

logger = logging.getLogger("jarvis.kokoro_service")

# Regex pattern for safe voice names (e.g., 'af_bella', 'am_adam', 'bf_emma')
# Prevents path traversal and injection via voice identifier
SAFE_VOICE_PATTERN = re.compile(r"^[a-zA-Z]{2}_[a-zA-Z0-9_-]{1,32}$")


class KokoroError(Exception):
    """Base exception for Kokoro TTS service."""


class KokoroModelNotFoundError(KokoroError):
    """Raised when Kokoro ONNX model or voice files cannot be found on disk."""


class KokoroInitializationError(KokoroError):
    """Raised when Kokoro model fails to load or initialize."""


class KokoroSynthesisError(KokoroError):
    """Raised when speech synthesis fails."""


def normalize_text_for_speech(text: str) -> str:
    """Normalize and strip Markdown artifacts from text for natural speech.

    Removes code blocks, inline code, URLs, Markdown formatting, and extra whitespace.
    """
    if not text:
        return ""

    # 1. Replace multi-line fenced code blocks with spoken notice
    cleaned = re.sub(r"```[\s\S]*?```", "Code block omitted.", text)

    # 2. Strip inline code delimiters: `foo` -> foo
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)

    # 3. Strip Markdown images: ![alt](url) -> ""
    cleaned = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", cleaned)

    # 4. Strip Markdown links: [text](url) -> text
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)

    # 5. Replace bare URLs with "link"
    cleaned = re.sub(r"https?://\S+", "link", cleaned)

    # 6. Strip Markdown headers: # Header -> Header
    cleaned = re.sub(r"^#{1,6}\s+", "", cleaned, flags=re.MULTILINE)

    # 7. Strip bold and italics: **text**, *text*, __text__, _text_
    cleaned = re.sub(r"[*_]{1,3}([^*_]+)[*_]{1,3}", r"\1", cleaned)

    # 8. Strip blockquotes: > quote -> quote
    cleaned = re.sub(r"^\s*>\s*", "", cleaned, flags=re.MULTILINE)

    # 9. Collapse multiple whitespace and newlines to a single space
    cleaned = re.sub(r"\s+", " ", cleaned).strip()

    return cleaned


class KokoroService:
    """Manages local Kokoro-82M neural TTS inference via ONNX Runtime."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.model_path = Path(self.settings.resolved_kokoro_model_path)
        self.voices_path = Path(self.settings.resolved_kokoro_voices_path)
        self.default_voice = self.settings.KOKORO_VOICE
        self.default_speed = self.settings.KOKORO_SPEED

        self._kokoro: Kokoro | None = None
        self._init_lock = asyncio.Lock()
        self._is_loaded = False

    @property
    def is_loaded(self) -> bool:
        """Return True if Kokoro model is loaded and ready for synthesis."""
        return self._is_loaded and self._kokoro is not None

    async def ensure_loaded(self) -> None:
        """Lazily initialize Kokoro model if not already loaded, safely guarded by an async lock."""
        if self.is_loaded:
            return

        async with self._init_lock:
            # Re-check under lock to avoid race conditions
            if self._is_loaded and self._kokoro is not None:
                return

            # Validate that files exist on disk
            if not self.model_path.is_file():
                err_msg = (
                    f"Kokoro model file not found at: {self.model_path}. "
                    "Please download 'kokoro-v1.0.onnx' into the models directory."
                )
                logger.error(err_msg)
                raise KokoroModelNotFoundError(err_msg)

            if not self.voices_path.is_file():
                err_msg = (
                    f"Kokoro voices file not found at: {self.voices_path}. "
                    "Please download 'voices-v1.0.bin' into the models directory."
                )
                logger.error(err_msg)
                raise KokoroModelNotFoundError(err_msg)

            def _load() -> Kokoro:
                logger.info(
                    "Loading Kokoro-82M ONNX model (model=%s, voices=%s)...",
                    self.model_path.name,
                    self.voices_path.name,
                )
                start_time = time.perf_counter()
                kokoro_instance = Kokoro(
                    model_path=str(self.model_path),
                    voices_path=str(self.voices_path),
                )
                load_time_ms = (time.perf_counter() - start_time) * 1000.0
                logger.info("Kokoro-82M successfully loaded in %.1fms", load_time_ms)
                return kokoro_instance

            try:
                self._kokoro = await asyncio.to_thread(_load)
                self._is_loaded = True
            except KokoroModelNotFoundError:
                raise
            except Exception as exc:
                self._kokoro = None
                self._is_loaded = False
                logger.error("Failed to initialize Kokoro-82M ONNX model: %s", exc, exc_info=True)
                raise KokoroInitializationError(f"Kokoro initialization failed: {exc}") from exc

    def validate_voice(self, voice: str | None) -> str:
        """Validate and sanitize voice identifier to prevent path traversal or invalid names.

        Args:
            voice: Voice identifier requested by caller.

        Returns:
            str: Validated safe voice identifier.
        """
        if not voice:
            return self.default_voice

        voice_clean = voice.strip()
        if not SAFE_VOICE_PATTERN.match(voice_clean):
            logger.warning(
                "Invalid voice identifier '%s' rejected; falling back to default '%s'",
                voice,
                self.default_voice,
            )
            return self.default_voice

        return voice_clean

    async def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float | None = None,
        lang: str = "en-us",
    ) -> tuple[bytes, float]:
        """Synthesize input text into 24kHz 16-bit PCM WAV bytes asynchronously.

        Args:
            text: Text to speak.
            voice: Optional voice identifier (defaults to configured KOKORO_VOICE).
            speed: Optional speech rate multiplier (defaults to configured KOKORO_SPEED).
            lang: Language code (defaults to 'en-us').

        Returns:
            tuple[bytes, float]: (wav_bytes, latency_ms)

        Raises:
            ValueError: If input text is empty after normalization.
            KokoroModelNotFoundError: If model files are missing.
            KokoroInitializationError: If model fails to initialize.
            KokoroSynthesisError: If synthesis fails.
        """
        clean_text = normalize_text_for_speech(text)
        if not clean_text:
            raise ValueError("Input text is empty or contains no pronounceable content.")

        # Ensure model is ready
        await self.ensure_loaded()
        assert self._kokoro is not None

        target_voice = self.validate_voice(voice)
        target_speed = float(speed if speed is not None else self.default_speed)

        start_time = time.perf_counter()

        def _do_inference() -> tuple[np.ndarray, int]:
            assert self._kokoro is not None
            # create returns (samples: np.ndarray[float32], sample_rate: int)
            samples, sample_rate = self._kokoro.create(
                clean_text,
                voice=target_voice,
                speed=target_speed,
                lang=lang,
            )
            return samples, sample_rate

        try:
            samples, sample_rate = await asyncio.to_thread(_do_inference)
        except Exception as exc:
            logger.error("Kokoro synthesis error for voice '%s': %s", target_voice, exc, exc_info=True)
            raise KokoroSynthesisError(f"Kokoro synthesis failed: {exc}") from exc

        # Package into 16-bit PCM WAV in memory
        def _to_wav(audio_samples: np.ndarray, sr: int) -> bytes:
            buf = io.BytesIO()
            sf.write(buf, audio_samples, sr, format="WAV", subtype="PCM_16")
            return buf.getvalue()

        wav_bytes = await asyncio.to_thread(_to_wav, samples, sample_rate)
        latency_ms = (time.perf_counter() - start_time) * 1000.0

        duration_sec = len(samples) / float(sample_rate) if sample_rate > 0 else 0.0
        logger.info(
            "Kokoro synthesized %.2fs audio (%d bytes WAV) in %.1fms (voice='%s', speed=%.2f)",
            duration_sec,
            len(wav_bytes),
            latency_ms,
            target_voice,
            target_speed,
        )

        return wav_bytes, latency_ms


_kokoro_service_instance: KokoroService | None = None


def get_kokoro_service(settings: Settings | None = None) -> KokoroService:
    """Return singleton KokoroService instance, initializing on first call."""
    global _kokoro_service_instance
    if _kokoro_service_instance is None:
        _kokoro_service_instance = KokoroService(settings=settings)
    return _kokoro_service_instance


def reset_kokoro_service() -> None:
    """Reset the singleton instance (useful for unit tests)."""
    global _kokoro_service_instance
    _kokoro_service_instance = None
