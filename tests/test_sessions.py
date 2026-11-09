"""Tests for GET /sessions and GET /sessions/{session_id} endpoints."""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_list_sessions_empty(async_client: AsyncClient) -> None:
    """Verify empty list when no sessions have been created."""
    response = await async_client.get("/sessions")
    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.asyncio
async def test_list_sessions_and_detail(async_client: AsyncClient) -> None:
    """Verify listing multiple sessions and retrieving individual session details."""
    # Create session 1 with 2 turns (4 messages)
    await async_client.post(
        "/chat", json={"session_id": "session-alpha", "message": "Alpha msg 1"}
    )
    await async_client.post(
        "/chat", json={"session_id": "session-alpha", "message": "Alpha msg 2"}
    )

    # Create session 2 with 1 turn (2 messages)
    await async_client.post(
        "/chat", json={"session_id": "session-beta", "message": "Beta msg 1"}
    )

    # 1. Test GET /sessions
    list_resp = await async_client.get("/sessions")
    assert list_resp.status_code == 200
    sessions = list_resp.json()
    assert len(sessions) == 2

    session_ids = [s["session_id"] for s in sessions]
    assert "session-alpha" in session_ids
    assert "session-beta" in session_ids

    alpha_summary = next(s for s in sessions if s["session_id"] == "session-alpha")
    assert alpha_summary["message_count"] == 4

    beta_summary = next(s for s in sessions if s["session_id"] == "session-beta")
    assert beta_summary["message_count"] == 2

    # 2. Test GET /sessions/{session_id}
    detail_resp = await async_client.get("/sessions/session-alpha")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["session_id"] == "session-alpha"
    assert detail["total_messages"] == 4
    assert len(detail["messages"]) == 4
    assert detail["messages"][0]["role"] == "user"
    assert detail["messages"][0]["content"] == "Alpha msg 1"
    assert detail["messages"][1]["role"] == "assistant"
    assert detail["messages"][2]["role"] == "user"
    assert detail["messages"][2]["content"] == "Alpha msg 2"

    # 3. Test GET /sessions/{non_existent} returns 404
    missing_resp = await async_client.get("/sessions/non-existent-id")
    assert missing_resp.status_code == 404

