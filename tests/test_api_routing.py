"""Unit and integration tests for production /api route aliases and static file serving."""

import asyncio
import os
from pathlib import Path
import pytest
from httpx import AsyncClient
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend.main import app
from backend.security import get_ticket_store
from tests.conftest import TEST_API_KEY, MockOllamaService


@pytest.mark.asyncio
async def test_api_status_endpoint(async_client: AsyncClient) -> None:
    """Verify that GET /api and GET /api/status return the JSON API status."""
    for path in ["/api", "/api/status"]:
        res = await async_client.get(path)
        assert res.status_code == 200
        data = res.json()
        assert data["project"] == "PROJECT JARVIS"
        assert data["status"] == "online"
        assert "health" in data


@pytest.mark.asyncio
async def test_api_health_requires_auth(unauthenticated_async_client: AsyncClient) -> None:
    """Verify that GET /api/health rejects unauthenticated requests with 401."""
    res = await unauthenticated_async_client.get("/api/health")
    assert res.status_code == 401
    assert res.headers.get("WWW-Authenticate") == "Bearer"


@pytest.mark.asyncio
async def test_api_health_authenticated(async_client: AsyncClient, mock_ollama: MockOllamaService) -> None:
    """Verify that GET /api/health succeeds with valid credentials."""
    mock_ollama.is_online = True
    mock_ollama.model_exists = True

    res = await async_client.get("/api/health")
    assert res.status_code == 200
    data = res.json()
    assert data["backend"] == "healthy"


@pytest.mark.asyncio
async def test_api_ws_ticket_issuance_requires_auth(unauthenticated_async_client: AsyncClient) -> None:
    """Verify that POST /api/auth/ws-ticket rejects unauthenticated requests with 401."""
    res = await unauthenticated_async_client.post("/api/auth/ws-ticket")
    assert res.status_code == 401


@pytest.mark.asyncio
async def test_api_ws_ticket_issuance_authenticated(async_client: AsyncClient) -> None:
    """Verify that POST /api/auth/ws-ticket issues single-use WebSocket tickets when authenticated."""
    res = await async_client.post("/api/auth/ws-ticket")
    assert res.status_code == 200
    data = res.json()
    assert "ticket" in data
    assert len(data["ticket"]) >= 32
    assert data["expires_in"] > 0


@pytest.mark.asyncio
async def test_api_chat_preserves_auth(
    unauthenticated_async_client: AsyncClient,
    async_client: AsyncClient,
    mock_ollama: MockOllamaService,
) -> None:
    """Verify that POST /api/chat enforces authentication and accepts valid requests."""
    payload = {"session_id": "test-api-session", "message": "hello jarvis"}

    # Unauthenticated: rejected with 401
    res_unauth = await unauthenticated_async_client.post("/api/chat", json=payload)
    assert res_unauth.status_code == 401

    # Authenticated: succeeds
    res_auth = await async_client.post("/api/chat", json=payload)
    assert res_auth.status_code == 200
    data = res_auth.json()
    assert data["session_id"] == "test-api-session"
    assert "reply" in data


@pytest.mark.asyncio
async def test_api_sessions_preserve_auth(
    unauthenticated_async_client: AsyncClient,
    async_client: AsyncClient,
) -> None:
    """Verify that GET /api/sessions and GET /api/sessions/{id} enforce authentication."""
    # List sessions: 401 when unauthenticated
    res_list_unauth = await unauthenticated_async_client.get("/api/sessions")
    assert res_list_unauth.status_code == 401

    # List sessions: 200 when authenticated
    res_list_auth = await async_client.get("/api/sessions")
    assert res_list_auth.status_code == 200
    assert isinstance(res_list_auth.json(), list)

    # Session details: 401 when unauthenticated
    res_detail_unauth = await unauthenticated_async_client.get("/api/sessions/nonexistent-session")
    assert res_detail_unauth.status_code == 401

    # Session details: 404 when authenticated but nonexistent
    res_detail_auth = await async_client.get("/api/sessions/nonexistent-session")
    assert res_detail_auth.status_code == 404


@pytest.mark.asyncio
async def test_root_level_endpoints_backward_compatibility(
    async_client: AsyncClient,
    mock_ollama: MockOllamaService,
) -> None:
    """Verify that legacy root-level HTTP routes continue to function."""
    mock_ollama.is_online = True
    mock_ollama.model_exists = True

    # Root /health
    res_health = await async_client.get("/health")
    assert res_health.status_code == 200

    # Root /sessions
    res_sessions = await async_client.get("/sessions")
    assert res_sessions.status_code == 200

    # Root /auth/ws-ticket
    res_ticket = await async_client.post("/auth/ws-ticket")
    assert res_ticket.status_code == 200


@pytest.mark.asyncio
async def test_root_default_accept_returns_json(async_client: AsyncClient) -> None:
    """Verify that GET / without an explicit text/html Accept header returns JSON status."""
    res = await async_client.get("/")
    assert res.status_code == 200
    data = res.json()
    assert data["project"] == "PROJECT JARVIS"
    assert data["status"] == "online"


@pytest.mark.asyncio
async def test_root_html_accept_serves_spa(async_client: AsyncClient) -> None:
    """Verify that GET / with text/html Accept header serves frontend/dist/index.html when present."""
    dist_index = Path(__file__).resolve().parent.parent / "frontend" / "dist" / "index.html"
    if dist_index.exists():
        headers = {"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}
        res = await async_client.get("/", headers=headers)
        assert res.status_code == 200
        assert "text/html" in res.headers.get("content-type", "")
        assert "<!doctype html>" in res.text.lower()


@pytest.mark.asyncio
async def test_assets_mount_serves_files_and_returns_404_for_missing(async_client: AsyncClient) -> None:
    """Verify that /assets mounts built static assets and returns 404 for missing assets."""
    assets_dir = Path(__file__).resolve().parent.parent / "frontend" / "dist" / "assets"
    if assets_dir.exists():
        # Find an existing file in assets
        existing_files = list(assets_dir.glob("*.js")) + list(assets_dir.glob("*.css"))
        if existing_files:
            sample_asset = existing_files[0].name
            res = await async_client.get(f"/assets/{sample_asset}")
            assert res.status_code == 200
            assert len(res.content) > 0

    # Missing asset must return 404
    missing_res = await async_client.get("/assets/nonexistent-static-file.js")
    assert missing_res.status_code == 404


def test_api_ws_voice_registered_once() -> None:
    """Verify that /api/ws/voice is registered exactly once in the application routing table."""
    def collect_ws_paths(routes):
        paths = []
        for r in routes:
            if hasattr(r, "original_router"):
                paths.extend(collect_ws_paths(r.original_router.routes))
            elif hasattr(r, "path") and not getattr(r, "methods", None):
                paths.append(r.path)
        return paths

    ws_paths = collect_ws_paths(app.routes)
    api_ws_voice_occurrences = [p for p in ws_paths if p == "/api/ws/voice"]
    assert len(api_ws_voice_occurrences) == 1, f"Expected exactly one /api/ws/voice, found {len(api_ws_voice_occurrences)}"
    assert "/ws/voice" in ws_paths, "Expected /ws/voice to remain registered"


def test_api_ws_voice_authentication_lifecycle() -> None:
    """Verify WebSocket authentication: rejection without ticket or with invalid ticket, acceptance with valid ticket."""
    client = TestClient(app)

    # 1. Missing ticket: rejected with 1008
    with pytest.raises(WebSocketDisconnect) as exc_missing:
        with client.websocket_connect("/api/ws/voice") as _:
            pass
    assert exc_missing.value.code == 1008

    # 2. Invalid ticket: rejected with 1008
    with pytest.raises(WebSocketDisconnect) as exc_invalid:
        with client.websocket_connect("/api/ws/voice?ticket=invalid-ticket-value-123") as _:
            pass
    assert exc_invalid.value.code == 1008

    # 3. Valid ticket: accepted and consumed atomically
    ticket = asyncio.run(get_ticket_store().create_ticket())
    with client.websocket_connect(f"/api/ws/voice?ticket={ticket}") as websocket:
        initial = websocket.receive_json()
        assert initial["type"] == "state_change"
        assert initial["state"] == "WAKE_LISTENING"

    # 4. Replaying the consumed ticket: rejected with 1008
    with pytest.raises(WebSocketDisconnect) as exc_replay:
        with client.websocket_connect(f"/api/ws/voice?ticket={ticket}") as _:
            pass
    assert exc_replay.value.code == 1008
