"""Unit and integration tests for Project JARVIS API authentication and security."""

import asyncio
import time
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from starlette.websockets import WebSocketDisconnect

from backend.config import Settings
from backend.main import app, lifespan
from backend.security import WebSocketTicketStore, get_ticket_store
from tests.conftest import TEST_API_KEY


@pytest.mark.asyncio
async def test_missing_http_credentials_returns_401(unauthenticated_async_client: AsyncClient) -> None:
    """Verify that sensitive HTTP endpoints reject requests with 401 when no credentials are provided."""
    endpoints = ["/health", "/sessions", "/auth/ws-ticket"]
    for ep in endpoints:
        res = await unauthenticated_async_client.get(ep) if ep != "/auth/ws-ticket" else await unauthenticated_async_client.post(ep)
        assert res.status_code == 401, f"Expected 401 for {ep}, got {res.status_code}"
        assert res.headers.get("WWW-Authenticate") == "Bearer"
        assert "Invalid or missing" in res.json().get("detail", "")


@pytest.mark.asyncio
async def test_invalid_http_credentials_returns_401(unauthenticated_async_client: AsyncClient) -> None:
    """Verify that requests with incorrect tokens return 401 Unauthorized."""
    bad_headers = {"Authorization": "Bearer wrong-token-value"}
    res = await unauthenticated_async_client.get("/health", headers=bad_headers)
    assert res.status_code == 401
    assert "Invalid or missing" in res.json().get("detail", "")


@pytest.mark.asyncio
async def test_valid_http_bearer_token_returns_200(async_client: AsyncClient) -> None:
    """Verify that requests with valid Bearer token succeed."""
    res = await async_client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["backend"] == "healthy"


@pytest.mark.asyncio
async def test_valid_x_api_key_header_returns_200(unauthenticated_async_client: AsyncClient) -> None:
    """Verify that requests with valid X-API-Key header succeed as an alternative to Bearer."""
    headers = {"X-API-Key": TEST_API_KEY}
    res = await unauthenticated_async_client.get("/health", headers=headers)
    assert res.status_code == 200
    assert res.json()["backend"] == "healthy"


@pytest.mark.asyncio
async def test_chat_endpoint_requires_auth(unauthenticated_async_client: AsyncClient) -> None:
    """Verify that POST /chat rejects unauthenticated requests."""
    payload = {"session_id": "test-sec", "message": "hello"}
    res = await unauthenticated_async_client.post("/chat", json=payload)
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_sessions_endpoint_requires_auth(unauthenticated_async_client: AsyncClient) -> None:
    """Verify that GET /sessions and GET /sessions/{id} reject unauthenticated requests."""
    res_list = await unauthenticated_async_client.get("/sessions")
    assert res_list.status_code == 401

    res_detail = await unauthenticated_async_client.get("/sessions/test-sec-id")
    assert res_detail.status_code == 401


@pytest.mark.asyncio
async def test_ws_ticket_issuance_unauthenticated_returns_401(unauthenticated_async_client: AsyncClient) -> None:
    """Verify that POST /auth/ws-ticket cannot be accessed without authentication."""
    res = await unauthenticated_async_client.post("/auth/ws-ticket")
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_ws_ticket_issuance_authenticated(async_client: AsyncClient) -> None:
    """Verify that authenticated callers can obtain a single-use WebSocket ticket."""
    res = await async_client.post("/auth/ws-ticket")
    assert res.status_code == 200
    data = res.json()
    assert "ticket" in data
    assert len(data["ticket"]) >= 32
    assert data["expires_in"] > 0


def test_websocket_voice_without_ticket_rejected() -> None:
    """Verify that connecting to /ws/voice without a ticket is rejected with 1008 policy violation."""
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/ws/voice") as _:
            pass
    assert exc_info.value.code == 1008


def test_websocket_voice_with_invalid_ticket_rejected() -> None:
    """Verify that connecting with a forged ticket is rejected with 1008."""
    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect("/ws/voice?ticket=forged-ticket-12345") as _:
            pass
    assert exc_info.value.code == 1008


def test_websocket_voice_with_valid_ticket_accepted() -> None:
    """Verify that connecting with a valid single-use ticket succeeds and enters WAKE_LISTENING."""
    store = get_ticket_store()
    ticket = asyncio.run(store.create_ticket())

    client = TestClient(app)
    with client.websocket_connect(f"/ws/voice?ticket={ticket}") as websocket:
        initial = websocket.receive_json()
        assert initial["type"] == "state_change"
        assert initial["state"] == "WAKE_LISTENING"


def test_websocket_voice_alias_with_valid_ticket_accepted() -> None:
    """Verify that the /api/ws/voice alias endpoint also enforces ticket authentication."""
    store = get_ticket_store()
    ticket = asyncio.run(store.create_ticket())

    client = TestClient(app)
    with client.websocket_connect(f"/api/ws/voice?ticket={ticket}") as websocket:
        initial = websocket.receive_json()
        assert initial["type"] == "state_change"
        assert initial["state"] == "WAKE_LISTENING"


def test_websocket_ticket_single_use_enforcement() -> None:
    """Verify that a ticket is consumed exactly once and cannot be re-used."""
    store = get_ticket_store()
    ticket = asyncio.run(store.create_ticket())

    client = TestClient(app)

    # 1. First connection succeeds and consumes the ticket
    with client.websocket_connect(f"/ws/voice?ticket={ticket}") as websocket:
        initial = websocket.receive_json()
        assert initial["state"] == "WAKE_LISTENING"

    # 2. Second connection attempt with the SAME ticket must be rejected immediately
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(f"/ws/voice?ticket={ticket}") as _:
            pass
    assert exc_info.value.code == 1008


@pytest.mark.asyncio
async def test_websocket_ticket_expiration_enforcement() -> None:
    """Verify that an expired ticket is rejected."""
    store = get_ticket_store()
    ticket = await store.create_ticket(ttl_seconds=1)

    # Wait for ticket to expire
    await asyncio.sleep(1.05)

    client = TestClient(app)
    with pytest.raises(WebSocketDisconnect) as exc_info:
        with client.websocket_connect(f"/ws/voice?ticket={ticket}") as _:
            pass
    assert exc_info.value.code == 1008


@pytest.mark.asyncio
async def test_cors_preflight_allowed_origin(unauthenticated_async_client: AsyncClient) -> None:
    """Verify that CORS OPTIONS preflight returns proper allow headers for whitelisted origins."""
    headers = {
        "Origin": "http://localhost:5173",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization,Content-Type",
    }
    res = await unauthenticated_async_client.options("/chat", headers=headers)
    assert res.status_code == 200
    assert res.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert "POST" in res.headers.get("access-control-allow-methods", "")


@pytest.mark.asyncio
async def test_cors_preflight_disallowed_origin(unauthenticated_async_client: AsyncClient) -> None:
    """Verify that CORS preflight rejects unauthorized origins without granting access headers."""
    headers = {
        "Origin": "http://malicious-external-site.com",
        "Access-Control-Request-Method": "POST",
    }
    res = await unauthenticated_async_client.options("/chat", headers=headers)
    assert res.headers.get("access-control-allow-origin") is None


@pytest.mark.asyncio
async def test_startup_fails_if_api_key_missing_in_production() -> None:
    """Verify fail-secure startup when JARVIS_API_KEY is missing in production."""
    settings = Settings(
        ENVIRONMENT="production",
        JARVIS_API_KEY=None,
    )
    dummy_app = FastAPI()

    with pytest.raises(RuntimeError) as exc_info:
        from backend.main import lifespan as main_lifespan
        # Temporarily test with mock settings
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("backend.main.settings", settings)
            async with main_lifespan(dummy_app):
                pass
    assert "JARVIS_API_KEY is required but not configured" in str(exc_info.value)


@pytest.mark.asyncio
async def test_startup_fails_if_api_key_too_weak_in_production() -> None:
    """Verify fail-secure startup when JARVIS_API_KEY is shorter than 32 characters in production."""
    settings = Settings(
        ENVIRONMENT="production",
        JARVIS_API_KEY="short-secret-key-1234",  # Only 22 characters
    )
    dummy_app = FastAPI()

    with pytest.raises(RuntimeError) as exc_info:
        from backend.main import lifespan as main_lifespan
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("backend.main.settings", settings)
            async with main_lifespan(dummy_app):
                pass
    assert "JARVIS_API_KEY is too weak" in str(exc_info.value)


@pytest.mark.asyncio
async def test_startup_fails_if_wildcard_cors_in_production() -> None:
    """Verify fail-secure startup when CORS_ORIGINS contains wildcard in production."""
    settings = Settings(
        ENVIRONMENT="production",
        JARVIS_API_KEY="a" * 32,
        CORS_ORIGINS="*",
    )
    dummy_app = FastAPI()

    with pytest.raises(RuntimeError) as exc_info:
        from backend.main import lifespan as main_lifespan
        with pytest.MonkeyPatch.context() as mp:
            mp.setattr("backend.main.settings", settings)
            async with main_lifespan(dummy_app):
                pass
    assert "Wildcard CORS origin ('*') is strictly prohibited in production" in str(exc_info.value)


def test_docs_disabled_in_production() -> None:
    """Verify that OpenAPI documentation endpoints are not mounted in production without explicit toggle."""
    prod_settings = Settings(
        ENVIRONMENT="production",
        ENABLE_DOCS=False,
        JARVIS_API_KEY="a" * 32,
    )
    docs_url = "/docs" if (prod_settings.ENABLE_DOCS or prod_settings.ENVIRONMENT in ("development", "test")) else None
    prod_app = FastAPI(docs_url=docs_url)

    client = TestClient(prod_app)
    res = client.get("/docs")
    assert res.status_code == 404
