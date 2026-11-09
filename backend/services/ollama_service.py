"""Service for interacting with local Ollama HTTP API."""

import logging
from typing import Any
from fastapi import HTTPException, status
import httpx
from backend.config import Settings, get_settings
from backend.models.schemas import OllamaHealth

logger = logging.getLogger("jarvis.ollama")


class OllamaService:
    """Handles communication with the local Ollama instance at http://127.0.0.1:11434."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()
        self.base_url = self.settings.OLLAMA_BASE_URL.rstrip("/")
        self.model = self.settings.OLLAMA_MODEL
        self.timeout = self.settings.OLLAMA_TIMEOUT_SECONDS

    async def check_health(self) -> OllamaHealth:
        """Query Ollama /api/tags to check service and model availability."""
        url = f"{self.base_url}/api/tags"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(url)
                if response.status_code == 200:
                    data = response.json()
                    models = [m.get("name", "") for m in data.get("models", [])]
                    # Check if target model (e.g. qwen2.5:3b or qwen2.5:3b:latest) is present
                    model_present = any(
                        self.model == m or m.startswith(f"{self.model}:") or self.model.startswith(m)
                        for m in models
                    )
                    detail = (
                        "Ollama is online and target model is ready."
                        if model_present
                        else f"Ollama is running, but model '{self.model}' is not pulled yet. Run 'ollama pull {self.model}' on Windows."
                    )
                    return OllamaHealth(
                        status="connected",
                        base_url=self.base_url,
                        target_model=self.model,
                        model_available=model_present,
                        detail=detail,
                    )
                return OllamaHealth(
                    status="unavailable",
                    base_url=self.base_url,
                    target_model=self.model,
                    model_available=False,
                    detail=f"Ollama returned HTTP status {response.status_code}: {response.text}",
                )
        except httpx.ConnectError:
            return OllamaHealth(
                status="unavailable",
                base_url=self.base_url,
                target_model=self.model,
                model_available=False,
                detail="Ollama service is unreachable at 127.0.0.1:11434. Verify Ollama is running.",
            )
        except httpx.TimeoutException:
            return OllamaHealth(
                status="unavailable",
                base_url=self.base_url,
                target_model=self.model,
                model_available=False,
                detail="Ollama health check timed out.",
            )
        except Exception as exc:  # pylint: disable=broad-except
            return OllamaHealth(
                status="unavailable",
                base_url=self.base_url,
                target_model=self.model,
                model_available=False,
                detail=f"Unexpected error contacting Ollama: {exc}",
            )

    async def generate_chat_reply(self, messages: list[dict[str, str]]) -> str:
        """Send chat messages to Ollama /api/chat and return the assistant reply.

        Args:
            messages: Formatted list of message dicts (e.g., [{'role': 'user', 'content': 'hi'}])

        Returns:
            The assistant text reply.

        Raises:
            HTTPException 503 if Ollama is unreachable.
            HTTPException 504 if Ollama times out.
            HTTPException 502 for upstream model or runtime errors.
        """
        url = f"{self.base_url}/api/chat"
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": False,
        }

        logger.info(
            "Sending chat request to Ollama (%s) with %d context messages",
            self.model,
            len(messages),
        )

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(url, json=payload)

            if response.status_code == 200:
                data = response.json()
                reply = data.get("message", {}).get("content", "")
                if not reply:
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail="Ollama returned an empty response.",
                    )
                return reply

            if response.status_code == 404:
                error_detail = (
                    f"Model '{self.model}' was not found in Ollama. "
                    f"Please run 'ollama pull {self.model}' in the Windows terminal."
                )
                logger.error(error_detail)
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=error_detail,
                )

            logger.error("Ollama error response (HTTP %d): %s", response.status_code, response.text)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Ollama returned HTTP {response.status_code}: {response.text}",
            )

        except httpx.ConnectError as exc:
            msg = (
                f"Ollama service is unreachable at {self.base_url}. "
                "Ensure Ollama is running locally on the Windows machine."
            )
            logger.error("Failed to connect to Ollama: %s", exc)
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=msg,
            ) from exc

        except httpx.TimeoutException as exc:
            msg = f"Ollama request timed out after {self.timeout} seconds."
            logger.error(msg)
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail=msg,
            ) from exc


_ollama_service: OllamaService | None = None


def get_ollama_service() -> OllamaService:
    """FastAPI dependency for OllamaService."""
    global _ollama_service
    if _ollama_service is None:
        _ollama_service = OllamaService()
    return _ollama_service

