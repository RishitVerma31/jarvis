"""SQLAlchemy database models for PROJECT JARVIS.

Stores conversation sessions and perpetual message history in SQLite.
"""

from datetime import datetime, timezone
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    """Base declarative class for all SQLAlchemy database models."""
    pass


class SessionModel(Base):
    """Database model representing a conversation session."""

    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(
        String(128),
        primary_key=True,
        index=True,
        comment="Unique identifier for the session (e.g., custom string or UUID)",
    )
    title: Mapped[str | None] = mapped_column(
        String(255),
        nullable=True,
        comment="Optional human-readable title or first message excerpt",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    # Relationship to messages: older messages are perpetually stored, never purged
    messages: Mapped[list["MessageModel"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="MessageModel.id.asc()",
    )

    def __repr__(self) -> str:
        return f"<SessionModel id='{self.id}' created_at='{self.created_at}'>"


class MessageModel(Base):
    """Database model representing a single message in a conversation.

    All messages are permanently retained in SQLite to maintain full history.
    """

    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
        index=True,
    )
    session_id: Mapped[str] = mapped_column(
        String(128),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    role: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        comment="Message sender: 'user', 'assistant', or 'system'",
    )
    content: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="The text content of the message",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )

    session: Mapped["SessionModel"] = relationship(back_populates="messages")

    def __repr__(self) -> str:
        return f"<MessageModel id={self.id} session_id='{self.session_id}' role='{self.role}'>"

