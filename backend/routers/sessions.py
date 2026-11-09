"""Sessions management router for PROJECT JARVIS."""

import logging
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.models.schemas import SessionDetailResponse, SessionSummary
from backend.services.chat_service import ChatService
from backend.services.ollama_service import OllamaService, get_ollama_service

logger = logging.getLogger("jarvis.routers.sessions")
router = APIRouter(prefix="/sessions", tags=["Sessions"])


@router.get(
    "",
    response_model=list[SessionSummary],
    summary="List all conversation sessions",
    description="Retrieves all stored conversation sessions with message counts and timestamps.",
)
async def list_sessions(
    db: AsyncSession = Depends(get_db),
    ollama: OllamaService = Depends(get_ollama_service),
) -> list[SessionSummary]:
    """List all conversation sessions."""
    chat_service = ChatService(db=db, ollama_service=ollama)
    return await chat_service.list_sessions()


@router.get(
    "/{session_id}",
    response_model=SessionDetailResponse,
    summary="Retrieve session history",
    description="Fetches all stored messages for a specific session.",
)
async def get_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    ollama: OllamaService = Depends(get_ollama_service),
) -> SessionDetailResponse:
    """Retrieve details and complete message history for a single session."""
    chat_service = ChatService(db=db, ollama_service=ollama)
    detail = await chat_service.get_session_details(session_id=session_id)
    if detail is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session '{session_id}' not found.",
        )
    return detail

