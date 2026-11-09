"""FastAPI application entry point for PROJECT JARVIS."""

from contextlib import asynccontextmanager
import logging
from typing import AsyncGenerator
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

from backend.config import get_settings
from backend.database import close_db, init_db
from backend.routers import (
    auth_router,
    chat_router,
    health_router,
    sessions_router,
    voice_router,
)
from backend.utils.logger import setup_logger

# Initialize application logger
logger = setup_logger("jarvis.main")
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan manager for startup and shutdown procedures."""
    logger.info("==================================================")
    logger.info("Starting PROJECT JARVIS backend...")
    logger.info("Host: %s | Port: %d", settings.HOST, settings.PORT)
    logger.info("Environment: %s", settings.ENVIRONMENT)
    logger.info("SQLite Database Path: %s", settings.resolved_db_path)
    logger.info("Application Log Path: %s", settings.resolved_log_path)
    logger.info("Ollama Base URL: %s (Model: %s)", settings.OLLAMA_BASE_URL, settings.OLLAMA_MODEL)
    logger.info("Context Window Limit: %d messages", settings.MAX_HISTORY_MESSAGES)
    logger.info("Models Storage Path: %s", settings.resolved_models_path)
    logger.info("Wake Word: %s (Threshold: %.2f)", settings.WAKE_WORD_MODEL, settings.WAKE_WORD_THRESHOLD)
    logger.info("Whisper STT: %s (Device: %s)", settings.WHISPER_MODEL_SIZE, settings.WHISPER_DEVICE)
    logger.info("CORS Allowed Origins: %s", settings.cors_origins_list)
    logger.info("Documentation Enabled: %s", settings.ENABLE_DOCS or settings.ENVIRONMENT == "development")
    logger.info("==================================================")

    # 1. Fail-secure startup validation: ensure strong API key is configured
    if settings.ENVIRONMENT != "test":
        if not settings.JARVIS_API_KEY:
            logger.critical("SECURITY CONFIGURATION ERROR: JARVIS_API_KEY is not set! Aborting startup.")
            raise RuntimeError(
                "CRITICAL: JARVIS_API_KEY is required but not configured. "
                "Set a secure, random 32+ character key in environment or .env before starting."
            )
        if len(settings.JARVIS_API_KEY.strip()) < 32:
            logger.critical(
                "SECURITY CONFIGURATION ERROR: JARVIS_API_KEY is too weak (<32 characters)! Aborting startup."
            )
            raise RuntimeError(
                f"CRITICAL: JARVIS_API_KEY is too weak ({len(settings.JARVIS_API_KEY.strip())} chars). "
                "Minimum 32 characters required for cryptographic security."
            )
        if "*" in settings.cors_origins_list:
            logger.critical(
                "SECURITY CONFIGURATION ERROR: Wildcard CORS origin ('*') is strictly prohibited in production."
            )
            raise RuntimeError("CRITICAL: Wildcard CORS origin ('*') is strictly prohibited in production.")

    # 2. Initialize SQLite schema and ensure storage directories
    await init_db()

    yield

    # 3. Cleanup resources on shutdown
    logger.info("Shutting down PROJECT JARVIS backend...")
    await close_db()
    logger.info("Shutdown complete.")


# Configure documentation availability: disabled outside development unless explicitly toggled
docs_url = "/docs" if (settings.ENABLE_DOCS or settings.ENVIRONMENT in ("development", "test")) else None
redoc_url = "/redoc" if (settings.ENABLE_DOCS or settings.ENVIRONMENT in ("development", "test")) else None
openapi_url = "/openapi.json" if (settings.ENABLE_DOCS or settings.ENVIRONMENT in ("development", "test")) else None

app = FastAPI(
    title="PROJECT JARVIS - Local AI Assistant API",
    description=(
        "Personal AI assistant backend running locally on Windows 11 with Ollama "
        "(qwen2.5:3b) and persistent SQLite conversation storage."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url=docs_url,
    redoc_url=redoc_url,
    openapi_url=openapi_url,
)

# Explicit CORS configuration (no wildcard in production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-API-Key"],
)


# Global validation error handler
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Provide readable error messages for input validation failures."""
    errors = exc.errors()
    simplified_errors = []
    for err in errors:
        loc = " -> ".join(str(x) for x in err.get("loc", []))
        msg = err.get("msg", "Validation error")
        simplified_errors.append(f"{loc}: {msg}")

    logger.warning("Validation error on %s: %s", request.url.path, simplified_errors)
    return JSONResponse(
        status_code=422,
        content={
            "error": "Validation Error",
            "details": simplified_errors,
        },
    )


# Include API Routers
app.include_router(auth_router)
app.include_router(health_router)
app.include_router(chat_router)
app.include_router(sessions_router)
app.include_router(voice_router)


@app.get("/", tags=["Root"])
async def root_status() -> dict[str, str | bool]:
    """Root status endpoint verifying API availability."""
    return {
        "project": "PROJECT JARVIS",
        "status": "online",
        "version": "1.0.0",
        "docs": docs_url or "disabled",
        "health": "/health",
    }


if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=False,
    )
