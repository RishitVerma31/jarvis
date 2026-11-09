"""Health check endpoint for PROJECT JARVIS."""

from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from backend.database import check_db_health
from backend.models.schemas import HealthResponse
from backend.services.ollama_service import OllamaService, get_ollama_service

router = APIRouter(tags=["Health"])


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="System and Ollama health check",
    description="Verifies the operational status of the FastAPI backend, SQLite database, and local Ollama service.",
)
async def health_check(
    ollama: OllamaService = Depends(get_ollama_service),
) -> HealthResponse:
    """Check health of backend, SQLite, and Ollama."""
    db_ok = await check_db_health()
    ollama_health = await ollama.check_health()

    if db_ok and ollama_health.status == "connected":
        overall_status = "healthy"
    elif db_ok:
        # Backend and database are working, but Ollama might be offline
        overall_status = "degraded"
    else:
        overall_status = "unhealthy"

    return HealthResponse(
        status=overall_status,
        backend="healthy",
        database="connected" if db_ok else "error",
        ollama=ollama_health,
        timestamp=datetime.now(timezone.utc),
    )
