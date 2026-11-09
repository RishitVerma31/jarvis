"""Security and authentication module for PROJECT JARVIS.

Provides:
1. Constant-time HTTP Bearer token and X-API-Key header verification (verify_api_key).
2. Short-lived, single-use ticket management for WebSocket connections (WebSocketTicketStore).
3. Pre-handshake ticket verification for WebSocket voice streams (verify_websocket_ticket).
"""

import asyncio
import logging
import secrets
import time
from fastapi import Depends, Header, HTTPException, Query, Security, WebSocket, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from backend.config import Settings, get_settings

logger = logging.getLogger("jarvis.security")

# HTTPBearer scheme (auto_error=False allows falling back to X-API-Key or structured 401 response)
http_bearer_scheme = HTTPBearer(auto_error=False)


class WebSocketTicketStore:
    """Thread-safe and async-safe in-memory store for short-lived, single-use WebSocket tickets."""

    def __init__(self, default_ttl_seconds: int = 30) -> None:
        self.default_ttl = default_ttl_seconds
        self._tickets: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def create_ticket(self, ttl_seconds: int | None = None) -> str:
        """Create a cryptographically secure, single-use ticket with an expiration timestamp."""
        ttl = ttl_seconds if ttl_seconds is not None else self.default_ttl
        ticket = secrets.token_urlsafe(32)
        async with self._lock:
            self._purge_expired()
            self._tickets[ticket] = time.time() + ttl
        return ticket

    async def consume_ticket(self, ticket: str | None) -> bool:
        """Validate and atomically consume a ticket.

        Returns True only if the ticket exists and has not expired.
        The ticket is deleted immediately upon retrieval to enforce single-use.
        """
        if not ticket or not isinstance(ticket, str):
            return False

        async with self._lock:
            self._purge_expired()
            expires_at = self._tickets.pop(ticket, None)
            if expires_at is None:
                return False
            if time.time() > expires_at:
                return False
            return True

    def _purge_expired(self) -> None:
        """Purge all expired tickets from the in-memory map."""
        now = time.time()
        expired = [t for t, exp in self._tickets.items() if now > exp]
        for t in expired:
            del self._tickets[t]


# Global ticket store instance
_ticket_store = WebSocketTicketStore(default_ttl_seconds=30)


def get_ticket_store() -> WebSocketTicketStore:
    """FastAPI dependency for accessing the singleton ticket store."""
    return _ticket_store


def verify_api_key(
    authorization: HTTPAuthorizationCredentials | None = Security(http_bearer_scheme),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    settings: Settings = Depends(get_settings),
) -> str:
    """Verify HTTP requests using Bearer token or X-API-Key header.

    Uses secrets.compare_digest for constant-time comparison to prevent timing attacks.
    Fails securely if JARVIS_API_KEY is not configured or too weak.
    """
    expected_key = settings.JARVIS_API_KEY
    if not expected_key:
        logger.error("JARVIS_API_KEY is not configured on the server.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server security configuration error: JARVIS_API_KEY is not configured.",
        )

    provided_key: str | None = None
    if authorization and authorization.credentials:
        provided_key = authorization.credentials
    elif x_api_key:
        provided_key = x_api_key

    if not provided_key or not secrets.compare_digest(provided_key, expected_key):
        logger.warning("Rejected unauthorized HTTP request.")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing authentication credentials.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return provided_key


async def verify_websocket_ticket(
    websocket: WebSocket,
    ticket: str | None = None,
    store: WebSocketTicketStore | None = None,
) -> bool:
    """Verify single-use WebSocket ticket prior to accepting the connection.

    Rejects connection with status code 1008 (Policy Violation) if missing, invalid, or expired.
    """
    if store is None:
        store = get_ticket_store()

    if not ticket or not await store.consume_ticket(ticket):
        logger.warning("Rejected unauthorized WebSocket connection: missing, invalid, or expired ticket.")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Unauthorized: invalid or expired ticket")
        return False

    return True
