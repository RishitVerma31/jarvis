"""Pytest test fixtures and configuration for PROJECT JARVIS."""

import os

# Test credentials and environment variables must be configured before backend modules import settings
TEST_DB_URL = "sqlite+aiosqlite:///:memory:"
TEST_API_KEY = "jarvis-test-suite-secure-key-32-chars-minimum-token-12345"

os.environ["ENVIRONMENT"] = "test"
os.environ["JARVIS_API_KEY"] = TEST_API_KEY
os.environ["CORS_ORIGINS"] = "http://localhost:5173,http://127.0.0.1:5173"

from collections.abc import AsyncGenerator
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from backend.config import Settings, get_settings
from backend.database import get_db
from backend.main import app
from backend.models.db_models import Base
from backend.models.schemas import OllamaHealth
from backend.services.ollama_service import OllamaService, get_ollama_service

get_settings.cache_clear()


class MockOllamaService(OllamaService):
    """Mock Ollama service for deterministic offline testing."""

    def __init__(self) -> None:
        super().__init__()
        self.is_online = True
        self.model_exists = True
        self.mock_reply = "I am Jarvis, your personal AI assistant. How may I help you today?"
        self.sent_messages: list[list[dict[str, str]]] = []
        self.simulate_timeout = False
        self.simulate_connect_error = False

    async def check_health(self) -> OllamaHealth:
        if self.simulate_connect_error or not self.is_online:
            return OllamaHealth(
                status="unavailable",
                base_url=self.base_url,
                target_model=self.model,
                model_available=False,
                detail="Mock: Ollama service is unreachable.",
            )
        return OllamaHealth(
            status="connected",
            base_url=self.base_url,
            target_model=self.model,
            model_available=self.model_exists,
            detail="Mock: Ollama is running normally.",
        )

    async def generate_chat_reply(self, messages: list[dict[str, str]]) -> str:
        self.sent_messages.append(messages)
        if self.simulate_connect_error or not self.is_online:
            from fastapi import HTTPException, status
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Ollama service is unreachable at {self.base_url}.",
            )
        if self.simulate_timeout:
            from fastapi import HTTPException, status
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail="Ollama request timed out.",
            )
        return self.mock_reply


@pytest_asyncio.fixture
async def test_engine() -> AsyncGenerator[AsyncEngine, None]:
    """Create an in-memory SQLite engine for the test session."""
    engine = create_async_engine(
        TEST_DB_URL,
        connect_args={"check_same_thread": False},
        future=True,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield engine

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def test_session(test_engine: AsyncEngine) -> AsyncGenerator[AsyncSession, None]:
    """Provide a transactional test database session."""
    session_factory = async_sessionmaker(
        bind=test_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False,
    )
    async with session_factory() as session:
        yield session


@pytest.fixture
def mock_ollama() -> MockOllamaService:
    """Provide a fresh mock Ollama service."""
    return MockOllamaService()


@pytest_asyncio.fixture
async def async_client(
    test_session: AsyncSession,
    mock_ollama: MockOllamaService,
) -> AsyncGenerator[AsyncClient, None]:
    """Provide an async test client configured with the test DB and mock Ollama."""
    async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
        yield test_session

    def override_get_ollama() -> OllamaService:
        return mock_ollama

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_ollama_service] = override_get_ollama

    transport = ASGITransport(app=app)
    headers = {"Authorization": f"Bearer {TEST_API_KEY}"}
    async with AsyncClient(transport=transport, base_url="http://testserver", headers=headers) as client:
        yield client

    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def unauthenticated_async_client(
    test_session: AsyncSession,
    mock_ollama: MockOllamaService,
) -> AsyncGenerator[AsyncClient, None]:
    """Provide an async test client without authentication headers."""
    async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
        yield test_session

    def override_get_ollama() -> OllamaService:
        return mock_ollama

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_ollama_service] = override_get_ollama

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client

    app.dependency_overrides.clear()

