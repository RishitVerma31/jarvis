"""Authentication router for PROJECT JARVIS.

Handles short-lived, single-use ticket issuance for WebSocket audio connections.
"""

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from backend.config import Settings, get_settings
from backend.security import WebSocketTicketStore, get_ticket_store, verify_api_key

router = APIRouter(prefix="/auth", tags=["Authentication"])


class WsTicketResponse(BaseModel):
    """Schema for WebSocket single-use ticket issuance response."""

    ticket: str = Field(description="Short-lived, single-use ticket for WebSocket authentication")
    expires_in: int = Field(description="Ticket validity duration in seconds")


@router.post(
    "/ws-ticket",
    response_model=WsTicketResponse,
    status_code=status.HTTP_200_OK,
    dependencies=[Depends(verify_api_key)],
    summary="Issue single-use WebSocket ticket",
    description="Generates an ephemeral, single-use ticket for authenticating WebSocket audio streams.",
)
async def issue_ws_ticket(
    settings: Settings = Depends(get_settings),
    store: WebSocketTicketStore = Depends(get_ticket_store),
) -> WsTicketResponse:
    """Issue a single-use WebSocket ticket for authenticated callers."""
    ttl = settings.WS_TICKET_TTL_SECONDS
    ticket = await store.create_ticket(ttl_seconds=ttl)
    return WsTicketResponse(ticket=ticket, expires_in=ttl)

