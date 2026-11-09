"""Chat router for PROJECT JARVIS."""

import logging
from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession
from backend.database import get_db
from backend.models.schemas import ChatRequest, ChatResponse
from backend.services.chat_service import ChatService
from backend.services.ollama_service import OllamaService, get_ollama_service

logger = logging.getLogger("jarvis.routers.chat")
router = APIRouter(tags=["Chat"])


@router.post(
    "/chat",
    response_model=ChatResponse,
    status_code=status.HTTP_200_OK,
    summary="Send a chat message",
    description="Sends a message within a session, pulls recent context, queries Ollama, and persists the conversation in SQLite.",
)
async def chat(
    payload: ChatRequest,
    db: AsyncSession = Depends(get_db),
    ollama: OllamaService = Depends(get_ollama_service),
) -> ChatResponse:
    """Handle chat interaction."""
    chat_service = ChatService(db=db, ollama_service=ollama)
    return await chat_service.process_chat(
        session_id=payload.session_id,
        user_message=payload.message,
    )

