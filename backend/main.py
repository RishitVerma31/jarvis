"""FastAPI application entry point for PROJECT JARVIS."""

from contextlib import asynccontextmanager
import logging
from typing import AsyncGenerator
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import uvicorn

from backend.config import get_settings
from backend.database import close_db, init_db
from backend.routers import chat_router, health_router, sessions_router
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
    logger.info("==================================================")

    # 1. Initialize SQLite schema and ensure storage directories
    await init_db()

    yield

    # 2. Cleanup resources on shutdown
    logger.info("Shutting down PROJECT JARVIS backend...")
    await close_db()
    logger.info("Shutdown complete.")


app = FastAPI(
    title="PROJECT JARVIS - Local AI Assistant API",
    description=(
        "Personal AI assistant backend running locally on Windows 11 with Ollama "
        "(qwen2.5:3b) and persistent SQLite conversation storage."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
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
app.include_router(health_router)
app.include_router(chat_router)
app.include_router(sessions_router)


@app.get("/", tags=["Root"])
async def root_status() -> dict[str, str]:
    """Root endpoint verifying API availability."""
    return {
        "project": "PROJECT JARVIS",
        "status": "online",
        "version": "1.0.0",
        "docs": "/docs",
        "health": "/health",
    }


if __name__ == "__main__":
    uvicorn.run(
        "backend.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=False,
    )
