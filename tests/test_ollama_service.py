"""Unit tests for the OllamaService class."""

import httpx
import pytest
from fastapi import HTTPException
from backend.config import Settings
from backend.services.ollama_service import OllamaService


@pytest.mark.asyncio
async def test_ollama_service_check_health_unreachable() -> None:
    """Verify OllamaService.check_health returns unavailable when Ollama is offline."""
    # Point to an unallocated port to guarantee connection refusal
    settings = Settings(OLLAMA_BASE_URL="http://127.0.0.1:59999", OLLAMA_TIMEOUT_SECONDS=1.0)
    service = OllamaService(settings=settings)

    health = await service.check_health()
    assert health.status == "unavailable"
    assert health.model_available is False
    assert "unreachable" in health.detail.lower()


@pytest.mark.asyncio
async def test_ollama_service_generate_unreachable_raises_503() -> None:
    """Verify OllamaService.generate_chat_reply raises 503 when Ollama is offline."""
    settings = Settings(OLLAMA_BASE_URL="http://127.0.0.1:59999", OLLAMA_TIMEOUT_SECONDS=1.0)
    service = OllamaService(settings=settings)

    with pytest.raises(HTTPException) as exc_info:
        await service.generate_chat_reply([{"role": "user", "content": "hello"}])

    assert exc_info.value.status_code == 503
    assert "unreachable" in exc_info.value.detail.lower()


@pytest.mark.asyncio
async def test_ollama_service_connect_timeout_raises_503(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify ConnectTimeout raises 503 Service Unavailable."""
    settings = Settings(OLLAMA_BASE_URL="http://127.0.0.1:11434", OLLAMA_TIMEOUT_SECONDS=1.0)
    service = OllamaService(settings=settings)

    async def mock_post(*args, **kwargs):
        raise httpx.ConnectTimeout("Connection timed out")

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)

    with pytest.raises(HTTPException) as exc_info:
        await service.generate_chat_reply([{"role": "user", "content": "hello"}])

    assert exc_info.value.status_code == 503
    assert "unreachable" in exc_info.value.detail.lower()


@pytest.mark.asyncio
async def test_ollama_service_read_timeout_raises_504(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify ReadTimeout raises 504 Gateway Timeout."""
    settings = Settings(OLLAMA_BASE_URL="http://127.0.0.1:11434", OLLAMA_TIMEOUT_SECONDS=1.0)
    service = OllamaService(settings=settings)

    async def mock_post(*args, **kwargs):
        raise httpx.ReadTimeout("Read timed out")

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)

    with pytest.raises(HTTPException) as exc_info:
        await service.generate_chat_reply([{"role": "user", "content": "hello"}])

    assert exc_info.value.status_code == 504
    assert "timed out" in exc_info.value.detail.lower()


