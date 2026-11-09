"""Tests for POST /chat, context window slicing, and SQLite persistence."""

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from backend.models.db_models import MessageModel, SessionModel
from tests.conftest import MockOllamaService


@pytest.mark.asyncio
async def test_chat_success(
    async_client: AsyncClient, mock_ollama: MockOllamaService
) -> None:
    """Test successful chat interaction."""
    payload = {"session_id": "session-1", "message": "Hello Jarvis"}
    response = await async_client.post("/chat", json=payload)

    assert response.status_code == 200
    data = response.json()
    assert data["session_id"] == "session-1"
    assert data["reply"] == mock_ollama.mock_reply
    assert data["model"] == "qwen2.5:3b"
    assert "created_at" in data

    # Verify context passed to Ollama had 1 message (the new user message)
    assert len(mock_ollama.sent_messages) == 1
    last_context = mock_ollama.sent_messages[-1]
    assert len(last_context) == 1
    assert last_context[0]["role"] == "user"
    assert last_context[0]["content"] == "Hello Jarvis"


@pytest.mark.asyncio
async def test_chat_input_validation(async_client: AsyncClient) -> None:
    """Verify input validation for empty or whitespace-only inputs."""
    # Empty message
    resp1 = await async_client.post("/chat", json={"session_id": "s1", "message": ""})
    assert resp1.status_code == 422

    # Whitespace message
    resp2 = await async_client.post("/chat", json={"session_id": "s1", "message": "   "})
    assert resp2.status_code == 422

    # Empty session_id
    resp3 = await async_client.post("/chat", json={"session_id": "", "message": "hi"})
    assert resp3.status_code == 422


@pytest.mark.asyncio
async def test_chat_history_retrieval(
    async_client: AsyncClient, mock_ollama: MockOllamaService
) -> None:
    """Verify that previous messages from the same session are retrieved and passed to Ollama."""
    session_id = "history-session"

    # Turn 1
    await async_client.post(
        "/chat", json={"session_id": session_id, "message": "My name is Bruce Wayne"}
    )
    # Turn 2
    await async_client.post(
        "/chat", json={"session_id": session_id, "message": "What is my name?"}
    )

    # In turn 2, context sent to Ollama should contain:
    # 1. user: "My name is Bruce Wayne"
    # 2. assistant: mock reply
    # 3. user: "What is my name?"
    assert len(mock_ollama.sent_messages) == 2
    turn2_context = mock_ollama.sent_messages[1]
    assert len(turn2_context) == 3
    assert turn2_context[0]["role"] == "user"
    assert turn2_context[0]["content"] == "My name is Bruce Wayne"
    assert turn2_context[1]["role"] == "assistant"
    assert turn2_context[2]["role"] == "user"
    assert turn2_context[2]["content"] == "What is my name?"


@pytest.mark.asyncio
async def test_context_window_limit_and_sqlite_retention(
    async_client: AsyncClient,
    test_session: AsyncSession,
    mock_ollama: MockOllamaService,
) -> None:
    """Verify context sliding window (latest 10 messages) while all messages remain in SQLite."""
    session_id = "sliding-window-session"

    # Send 8 turns (16 messages total: 8 user + 8 assistant)
    for i in range(1, 9):
        resp = await async_client.post(
            "/chat", json={"session_id": session_id, "message": f"Message {i}"}
        )
        assert resp.status_code == 200

    # On the 8th turn:
    # Previous messages = 7 turns * 2 = 14 messages in DB.
    # Sliced context should take strictly the latest 10 messages + the 8th user message = 11 messages.
    turn8_context = mock_ollama.sent_messages[7]
    assert len(turn8_context) == 11
    # The last context message is the current user message:
    assert turn8_context[-1]["content"] == "Message 8"

    # Now verify SQLite database persistence:
    # None of the earlier records should have been deleted!
    count_stmt = select(func.count(MessageModel.id)).where(MessageModel.session_id == session_id)
    count_res = await test_session.execute(count_stmt)
    total_messages = count_res.scalar_one()

    # 8 user messages + 8 assistant replies = 16 messages perpetually preserved
    assert total_messages == 16


@pytest.mark.asyncio
async def test_chat_ollama_unavailable_returns_503(
    async_client: AsyncClient, mock_ollama: MockOllamaService
) -> None:
    """Verify that clear 503 error is returned when Ollama is unreachable."""
    mock_ollama.simulate_connect_error = True

    response = await async_client.post(
        "/chat", json={"session_id": "err-session", "message": "Are you there?"}
    )
    assert response.status_code == 503
    data = response.json()
    assert "unreachable" in data["detail"]


@pytest.mark.asyncio
async def test_chat_ollama_timeout_returns_504(
    async_client: AsyncClient, mock_ollama: MockOllamaService
) -> None:
    """Verify that 504 Gateway Timeout is returned if Ollama times out."""
    mock_ollama.simulate_timeout = True

    response = await async_client.post(
        "/chat", json={"session_id": "err-session", "message": "Slow request"}
    )
    assert response.status_code == 504
    data = response.json()
    assert "timed out" in data["detail"]
