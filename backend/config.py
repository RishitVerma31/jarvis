"""Application configuration management for PROJECT JARVIS.

Handles environment variables, default settings, and cross-platform
path resolution between Windows 11 production and macOS development.
"""

from functools import lru_cache
import os
from pathlib import Path
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration settings loaded from environment or .env file."""

    model_config = SettingsConfigDict(
        env_file=(".env", r"D:\Jarvis\.env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server binding
    # 0.0.0.0 allows LAN access (e.g., MacBook to Windows host over Wi-Fi)
    HOST: str = Field(default="0.0.0.0", description="Host interface to bind to")
    PORT: int = Field(default=8000, description="Port to listen on")
    ENVIRONMENT: str = Field(default="production", description="Environment name")

    # API Security & Authentication
    JARVIS_API_KEY: str | None = Field(
        default=None,
        description="Cryptographic secret API key for authenticating HTTP clients",
    )
    CORS_ORIGINS: str = Field(
        default="http://localhost:5173,http://127.0.0.1:5173",
        description="Comma-separated or JSON list of explicit allowed CORS origins",
    )
    ENABLE_DOCS: bool = Field(
        default=False,
        description="Explicit toggle for interactive OpenAPI documentation outside development",
    )
    WS_TICKET_TTL_SECONDS: int = Field(
        default=30,
        description="Lifetime in seconds for short-lived, single-use WebSocket tickets",
    )

    @property
    def cors_origins_list(self) -> list[str]:
        """Return CORS_ORIGINS as a parsed list of origin strings."""
        val = self.CORS_ORIGINS.strip()
        if val.startswith("[") and val.endswith("]"):
            import json
            return json.loads(val)
        return [orig.strip() for orig in val.split(",") if orig.strip()]

    # Ollama settings (Strictly localhost 127.0.0.1, never exposed externally)
    OLLAMA_BASE_URL: str = Field(
        default="http://127.0.0.1:11434",
        description="Local Ollama HTTP endpoint",
    )
    OLLAMA_MODEL: str = Field(
        default="qwen2.5:3b",
        description="Default Ollama model identifier",
    )
    OLLAMA_TIMEOUT_SECONDS: float = Field(
        default=60.0,
        description="Timeout in seconds for Ollama inference requests",
    )

    # Context window limit: Maximum messages sent to Ollama in chat context.
    # Note: Full conversation history is ALWAYS preserved indefinitely in SQLite.
    MAX_HISTORY_MESSAGES: int = Field(
        default=10,
        description="Number of recent messages to include as prompt context",
    )

    # Windows 11 Production storage paths
    JARVIS_DB_PATH: str = Field(
        default=r"D:\Jarvis\database\jarvis.db",
        description="Path to SQLite database file",
    )
    JARVIS_LOG_PATH: str = Field(
        default=r"D:\Jarvis\logs\jarvis.log",
        description="Path to application log file",
    )
    JARVIS_MODELS_PATH: str = Field(
        default=r"D:\Jarvis\models",
        description="Path to voice and speech model files",
    )

    # Voice Assistant (Stage 2.6)
    WAKE_WORD_MODEL: str = Field(
        default="hey_jarvis_v0.1",
        description="Identifier of openWakeWord wake model",
    )
    WAKE_WORD_THRESHOLD: float = Field(
        default=0.7,
        description="Confidence threshold for wake word activation",
    )
    WAKE_WORD_COOLDOWN_SECONDS: float = Field(
        default=2.0,
        description="Cooldown seconds after wake word triggers to avoid repeated activation",
    )
    WHISPER_MODEL_SIZE: str = Field(
        default="base.en",
        description="faster-whisper model size (e.g. 'base.en', 'small.en')",
    )
    WHISPER_DEVICE: str = Field(
        default="cpu",
        description="Compute device for faster-whisper ('cuda', 'cpu', or 'auto')",
    )
    WHISPER_COMPUTE_TYPE: str = Field(
        default="int8",
        description="Precision for faster-whisper ('float16', 'int8', or 'auto')",
    )

    # Kokoro-82M Neural TTS Settings
    ENABLE_KOKORO_TTS: bool = Field(
        default=True,
        description="Enable local Kokoro-82M neural TTS speech generation",
    )
    KOKORO_MODEL_PATH: str = Field(
        default=r"D:\Jarvis\models\kokoro\kokoro-v1.0.onnx",
        description="Path to Kokoro ONNX model file",
    )
    KOKORO_VOICES_PATH: str = Field(
        default=r"D:\Jarvis\models\kokoro\voices-v1.0.bin",
        description="Path to Kokoro voices bin file",
    )
    KOKORO_VOICE: str = Field(
        default="af_bella",
        description="Default Kokoro voice identifier (e.g. 'af_bella')",
    )
    KOKORO_SPEED: float = Field(
        default=1.0,
        description="Speech speed multiplier (1.0 = normal)",
    )

    @property
    def project_root(self) -> Path:
        """Return the root directory of the project."""
        return Path(__file__).resolve().parent.parent

    @property
    def resolved_db_path(self) -> Path:
        """Resolve database path, falling back to local ./data on macOS/Linux or missing D: drive."""
        raw_path = Path(self.JARVIS_DB_PATH)

        # On non-Windows OS (e.g. macOS dev), fall back to ./data if configured for D:\
        if os.name != "nt":
            if str(raw_path).startswith("D:") or str(raw_path).startswith("d:"):
                fallback = self.project_root / "data" / "database" / "jarvis.db"
                return fallback.resolve()
            return raw_path.resolve()

        # On Windows, verify if the drive exists; if not, fallback to local data
        drive = raw_path.drive
        if drive and not os.path.exists(f"{drive}\\"):
            fallback = self.project_root / "data" / "database" / "jarvis.db"
            return fallback.resolve()

        return raw_path.resolve()

    @property
    def resolved_log_path(self) -> Path:
        """Resolve log path, falling back to local ./data on macOS/Linux or missing D: drive."""
        raw_path = Path(self.JARVIS_LOG_PATH)

        # On non-Windows OS (e.g. macOS dev), fall back to ./data if configured for D:\
        if os.name != "nt":
            if str(raw_path).startswith("D:") or str(raw_path).startswith("d:"):
                fallback = self.project_root / "data" / "logs" / "jarvis.log"
                return fallback.resolve()
            return raw_path.resolve()

        # On Windows, verify if the drive exists; if not, fallback to local data
        drive = raw_path.drive
        if drive and not os.path.exists(f"{drive}\\"):
            fallback = self.project_root / "data" / "logs" / "jarvis.log"
            return fallback.resolve()

        return raw_path.resolve()

    @property
    def resolved_models_path(self) -> Path:
        """Resolve models cache directory, falling back to local ./data on macOS/Linux or missing D: drive."""
        raw_path = Path(self.JARVIS_MODELS_PATH)

        if os.name != "nt":
            if str(raw_path).startswith("D:") or str(raw_path).startswith("d:"):
                fallback = self.project_root / "data" / "models"
                return fallback.resolve()
            return raw_path.resolve()

        drive = raw_path.drive
        if drive and not os.path.exists(f"{drive}\\"):
            fallback = self.project_root / "data" / "models"
            return fallback.resolve()

        return raw_path.resolve()

    @property
    def resolved_kokoro_model_path(self) -> Path:
        """Resolve Kokoro ONNX model path, falling back to local ./data on non-Windows or missing D: drive."""
        raw_path = Path(self.KOKORO_MODEL_PATH)
        if os.name != "nt":
            if str(raw_path).startswith("D:") or str(raw_path).startswith("d:"):
                return (self.resolved_models_path / "kokoro" / raw_path.name).resolve()
            return raw_path.resolve()

        drive = raw_path.drive
        if drive and not os.path.exists(f"{drive}\\"):
            return (self.resolved_models_path / "kokoro" / raw_path.name).resolve()

        return raw_path.resolve()

    @property
    def resolved_kokoro_voices_path(self) -> Path:
        """Resolve Kokoro voices path, falling back to local ./data on non-Windows or missing D: drive."""
        raw_path = Path(self.KOKORO_VOICES_PATH)
        if os.name != "nt":
            if str(raw_path).startswith("D:") or str(raw_path).startswith("d:"):
                return (self.resolved_models_path / "kokoro" / raw_path.name).resolve()
            return raw_path.resolve()

        drive = raw_path.drive
        if drive and not os.path.exists(f"{drive}\\"):
            return (self.resolved_models_path / "kokoro" / raw_path.name).resolve()

        return raw_path.resolve()

    @property
    def database_url(self) -> str:
        """Return async SQLite SQLAlchemy URL."""
        posix_path = self.resolved_db_path.as_posix()
        # On POSIX: /path/to/db -> sqlite+aiosqlite:////path/to/db
        # On Windows: D:/Jarvis/... -> sqlite+aiosqlite:///D:/Jarvis/...
        if posix_path.startswith("/"):
            return f"sqlite+aiosqlite:///{posix_path}"
        return f"sqlite+aiosqlite:///{posix_path}"

    def ensure_directories(self) -> None:
        """Ensure parent directories for database, log, and model files exist."""
        self.resolved_db_path.parent.mkdir(parents=True, exist_ok=True)
        self.resolved_log_path.parent.mkdir(parents=True, exist_ok=True)
        self.resolved_models_path.mkdir(parents=True, exist_ok=True)
        self.resolved_kokoro_model_path.parent.mkdir(parents=True, exist_ok=True)


@lru_cache()
def get_settings() -> Settings:
    """Return cached Settings instance."""
    return Settings()

