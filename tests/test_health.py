"""Tests for GET /health and root endpoints."""

import pytest
from httpx import AsyncClient
from tests.conftest import MockOllamaService


@pytest.mark.asyncio
async def test_root_endpoint(async_client: AsyncClient) -> None:
    """Verify that root endpoint returns basic project status."""
    response = await async_client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["project"] == "PROJECT JARVIS"
    assert data["status"] == "online"
    assert data["docs"] == "/docs"


@pytest.mark.asyncio
async def test_health_check_healthy(
    async_client: AsyncClient, mock_ollama: MockOllamaService
) -> None:
    """Verify that GET /health returns 'healthy' when Ollama is available."""
    mock_ollama.is_online = True
    mock_ollama.model_exists = True

    response = await async_client.get("/health")
    assert response.status_code == 200

    data = response.json()
    assert data["status"] == "healthy"
    assert data["backend"] == "healthy"
    assert data["database"] == "connected"
    assert data["ollama"]["status"] == "connected"
    assert data["ollama"]["model_available"] is True
    assert data["ollama"]["target_model"] == "qwen2.5:3b"


@pytest.mark.asyncio
async def test_health_check_degraded_when_ollama_offline(
    async_client: AsyncClient, mock_ollama: MockOllamaService
) -> None:
    """Verify that GET /health returns 'degraded' when Ollama is offline."""
    mock_ollama.is_online = False

    response = await async_client.get("/health")
    assert response.status_code == 200

    data = response.json()
    assert data["status"] == "degraded"
    assert data["backend"] == "healthy"
    assert data["database"] == "connected"
    assert data["ollama"]["status"] == "unavailable"
    assert data["ollama"]["model_available"] is False
    assert "unreachable" in data["ollama"]["detail"]

