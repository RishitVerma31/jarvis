"""Tests for configuration and cross-platform path resolution."""

import os
from pathlib import Path
from backend.config import Settings


def test_settings_defaults() -> None:
    """Verify default setting values."""
    settings = Settings()
    assert settings.HOST == "0.0.0.0"
    assert settings.PORT == 8000
    assert settings.OLLAMA_BASE_URL == "http://127.0.0.1:11434"
    assert settings.OLLAMA_MODEL == "qwen2.5:3b"
    assert settings.MAX_HISTORY_MESSAGES == 10


def test_path_resolution_fallback_on_posix() -> None:
    """Verify that D:\\ paths on non-Windows fallback to local ./data."""
    settings = Settings(
        JARVIS_DB_PATH=r"D:\Jarvis\database\jarvis.db",
        JARVIS_LOG_PATH=r"D:\Jarvis\logs\jarvis.log",
    )

    if os.name != "nt":
        resolved_db = settings.resolved_db_path
        resolved_log = settings.resolved_log_path
        assert "data" in str(resolved_db)
        assert "data" in str(resolved_log)
        assert not str(resolved_db).startswith("D:")

