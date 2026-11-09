"""Pydantic schemas for request validation and API responses in PROJECT JARVIS."""

from datetime import datetime
from typing import Any
from pydantic import BaseModel, ConfigDict, Field, field_validator


class ChatRequest(BaseModel):
    """Payload for POST /chat."""

    session_id: str = Field(
        ...,
        min_length=1,
        max_length=128,
        description="Unique identifier for the chat session",
        examples=["default-session", "session-12345"],
    )
    message: str = Field(
        ...,
        min_length=1,
        description="User text message to send to the assistant",
        examples=["Hello Jarvis, who are you?"],
    )

    @field_validator("session_id", "message")
    @classmethod
    def strip_whitespace(cls, value: str) -> str:
        """Strip whitespace and ensure non-empty content."""
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Field cannot be empty or contain only whitespace")
        return trimmed


class ChatResponse(BaseModel):
    """Response payload returned by POST /chat."""

    session_id: str = Field(description="Active session ID")
    reply: str = Field(description="Assistant response text")
    model: str = Field(description="Name of the model generating the reply")
    created_at: datetime = Field(description="Timestamp of the generated reply")


class MessageSchema(BaseModel):
    """Schema representing an individual stored message."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    content: str
    created_at: datetime


class SessionSummary(BaseModel):
    """Summary of a chat session returned in GET /sessions."""

    session_id: str
    title: str | None = None
    message_count: int
    created_at: datetime
    updated_at: datetime
    last_message: str | None = None


class SessionDetailResponse(BaseModel):
    """Detailed session view with full message history."""

    session_id: str
    title: str | None = None
    created_at: datetime
    updated_at: datetime
    total_messages: int
    messages: list[MessageSchema]


class OllamaHealth(BaseModel):
    """Health status details for the local Ollama service."""

    status: str = Field(description="'connected' or 'unavailable'")
    base_url: str
    target_model: str
    model_available: bool = False
    detail: str | None = None


class HealthResponse(BaseModel):
    """Response payload returned by GET /health."""

    status: str = Field(description="'healthy' if backend and DB are up; 'degraded' if Ollama is down")
    backend: str = "healthy"
    database: str = "connected"
    ollama: OllamaHealth
    timestamp: datetime
