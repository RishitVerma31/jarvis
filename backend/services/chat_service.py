"""Chat service handling conversation context slicing, Ollama dispatch, and perpetual SQLite persistence."""

from datetime import datetime, timezone
import logging
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from backend.config import Settings, get_settings
from backend.models.db_models import MessageModel, SessionModel
from backend.models.schemas import (
    ChatResponse,
    MessageSchema,
    SessionDetailResponse,
    SessionSummary,
)
from backend.services.ollama_service import OllamaService

logger = logging.getLogger("jarvis.chat_service")


class ChatService:
    """Coordinates conversation retrieval, context limiting, and database persistence."""

    def __init__(
        self,
        db: AsyncSession,
        ollama_service: OllamaService,
        settings: Settings | None = None,
    ) -> None:
        self.db = db
        self.ollama = ollama_service
        self.settings = settings or get_settings()

    async def get_or_create_session(
        self, session_id: str, title_hint: str | None = None
    ) -> SessionModel:
        """Retrieve an existing session or create a new one."""
        stmt = select(SessionModel).where(SessionModel.id == session_id)
        result = await self.db.execute(stmt)
        session_obj = result.scalar_one_or_none()

        if session_obj is None:
            title = None
            if title_hint:
                # Use first ~50 chars of first message as conversation title
                title = title_hint.strip()[:50]
                if len(title_hint.strip()) > 50:
                    title += "..."
            session_obj = SessionModel(
                id=session_id,
                title=title,
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )
            self.db.add(session_obj)
            await self.db.flush()
            logger.info("Created new session: %s", session_id)

        return session_obj

    async def get_context_for_model(self, session_id: str) -> list[dict[str, str]]:
        """Fetch strictly the latest MAX_HISTORY_MESSAGES for Ollama prompt context.

        Older conversation records remain permanently in SQLite and are NOT modified.
        """
        limit = self.settings.MAX_HISTORY_MESSAGES
        stmt = (
            select(MessageModel)
            .where(MessageModel.session_id == session_id)
            .order_by(MessageModel.id.desc())
            .limit(limit)
        )
        result = await self.db.execute(stmt)
        recent_messages = list(result.scalars().all())

        # Reverse back to chronological order (earliest -> newest)
        recent_messages.reverse()
        return [{"role": m.role, "content": m.content} for m in recent_messages]

    async def process_chat(self, session_id: str, user_message: str) -> ChatResponse:
        """Process incoming chat message:

        1. Ensure session exists.
        2. Fetch latest 10 messages for context (non-destructive).
        3. Append current user message.
        4. Request completion from Ollama.
        5. Persist both user message and assistant reply to SQLite indefinitely.
        """
        # 1. Session lookup / creation
        session_obj = await self.get_or_create_session(session_id, title_hint=user_message)

        # 2. Build prompt context (strictly latest 10 messages)
        context = await self.get_context_for_model(session_id)

        # 3. Append current user message to context payload
        context.append({"role": "user", "content": user_message})

        # 4. Dispatch to Ollama
        reply_text = await self.ollama.generate_chat_reply(context)

        # 5. Persist permanently to SQLite
        now = datetime.now(timezone.utc)
        user_record = MessageModel(
            session_id=session_id,
            role="user",
            content=user_message,
            created_at=now,
        )
        assistant_record = MessageModel(
            session_id=session_id,
            role="assistant",
            content=reply_text,
            created_at=now,
        )

        session_obj.updated_at = now
        self.db.add_all([user_record, assistant_record])
        await self.db.commit()

        logger.info("Persisted user and assistant messages for session '%s'", session_id)

        return ChatResponse(
            session_id=session_id,
            reply=reply_text,
            model=self.settings.OLLAMA_MODEL,
            created_at=assistant_record.created_at,
        )

    async def list_sessions(self) -> list[SessionSummary]:
        """List all conversation sessions with message counts and timestamps."""
        stmt = select(SessionModel).order_by(SessionModel.updated_at.desc())
        result = await self.db.execute(stmt)
        sessions = result.scalars().all()

        summaries: list[SessionSummary] = []
        for s in sessions:
            # Count total messages for this session
            count_stmt = select(func.count(MessageModel.id)).where(MessageModel.session_id == s.id)
            count_res = await self.db.execute(count_stmt)
            total = count_res.scalar_one() or 0

            # Get latest message preview
            last_msg_stmt = (
                select(MessageModel.content)
                .where(MessageModel.session_id == s.id)
                .order_by(MessageModel.id.desc())
                .limit(1)
            )
            last_msg_res = await self.db.execute(last_msg_stmt)
            last_msg = last_msg_res.scalar_one_or_none()

            summaries.append(
                SessionSummary(
                    session_id=s.id,
                    title=s.title,
                    message_count=total,
                    created_at=s.created_at,
                    updated_at=s.updated_at,
                    last_message=last_msg,
                )
            )

        return summaries

    async def get_session_details(self, session_id: str) -> SessionDetailResponse | None:
        """Retrieve complete session history for inspection."""
        stmt = select(SessionModel).where(SessionModel.id == session_id)
        result = await self.db.execute(stmt)
        session_obj = result.scalar_one_or_none()

        if session_obj is None:
            return None

        # Fetch all messages in chronological order
        msg_stmt = (
            select(MessageModel)
            .where(MessageModel.session_id == session_id)
            .order_by(MessageModel.id.asc())
        )
        msg_res = await self.db.execute(msg_stmt)
        messages = msg_res.scalars().all()

        return SessionDetailResponse(
            session_id=session_obj.id,
            title=session_obj.title,
            created_at=session_obj.created_at,
            updated_at=session_obj.updated_at,
            total_messages=len(messages),
            messages=[
                MessageSchema(
                    id=m.id,
                    role=m.role,
                    content=m.content,
                    created_at=m.created_at,
                )
                for m in messages
            ],
        )

