"""Application configuration management for PROJECT JARVIS.

Handles environment variables, default settings, and cross-platform
path resolution between Windows 11 production and macOS development.
"""

from functools import lru_cache
import os
from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration settings loaded from environment or .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Server binding
    # 0.0.0.0 allows LAN access (e.g., MacBook to Windows host over Wi-Fi)
    HOST: str = Field(default="0.0.0.0", description="Host interface to bind to")
    PORT: int = Field(default=8000, description="Port to listen on")
    ENVIRONMENT: str = Field(default="production", description="Environment name")

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
    def database_url(self) -> str:
        """Return async SQLite SQLAlchemy URL."""
        posix_path = self.resolved_db_path.as_posix()
        # On POSIX: /path/to/db -> sqlite+aiosqlite:////path/to/db
        # On Windows: D:/Jarvis/... -> sqlite+aiosqlite:///D:/Jarvis/...
        if posix_path.startswith("/"):
            return f"sqlite+aiosqlite:///{posix_path}"
        return f"sqlite+aiosqlite:///{posix_path}"

    def ensure_directories(self) -> None:
        """Ensure parent directories for database and log files exist."""
        self.resolved_db_path.parent.mkdir(parents=True, exist_ok=True)
        self.resolved_log_path.parent.mkdir(parents=True, exist_ok=True)


@lru_cache()
def get_settings() -> Settings:
    """Return cached Settings instance."""
    return Settings()

