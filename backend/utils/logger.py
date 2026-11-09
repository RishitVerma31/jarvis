"""Logging configuration for PROJECT JARVIS.

Sets up console logging and rotating file logging into the configured log path.
"""

import logging
from logging.handlers import RotatingFileHandler
import sys
from pathlib import Path
from backend.config import get_settings


def setup_logger(name: str = "jarvis") -> logging.Logger:
    """Set up and return a configured logger instance."""
    settings = get_settings()
    logger = logging.getLogger(name)

    # Avoid adding duplicate handlers if already configured
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    logger.propagate = False
    formatter = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(name)s (%(filename)s:%(lineno)d): %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 1. Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.INFO)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # 2. Rotating file handler
    try:
        log_path = settings.resolved_log_path
        log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = RotatingFileHandler(
            filename=str(log_path),
            maxBytes=10 * 1024 * 1024,  # 10 MB per log file
            backupCount=5,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.INFO)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)
    except Exception as exc:  # pylint: disable=broad-except
        logger.warning("Could not set up file logger at %s: %s", settings.resolved_log_path, exc)

    return logger


logger = setup_logger()

