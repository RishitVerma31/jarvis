"""Voice WebSocket router for PROJECT JARVIS.

Manages bidirectional real-time audio streaming, wake-word detection,
voice activity detection, speech-to-text, and conversational response dispatch.
"""

import base64
import json
import logging
import time
from typing import Any
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from backend.config import get_settings
from backend.database import get_session_factory
from backend.security import verify_websocket_ticket
from backend.services.chat_service import ChatService
from backend.services.kokoro_service import get_kokoro_service
from backend.services.ollama_service import get_ollama_service
from backend.services.voice_service import get_voice_service

logger = logging.getLogger("jarvis.routers.voice")
router = APIRouter(tags=["Voice"])

# Timing constants
SILENCE_TIMEOUT_SECONDS = 1.2
MAX_RECORDING_SECONDS = 15.0
INITIAL_SPEECH_TIMEOUT_SECONDS = 4.0


async def handle_voice_websocket(websocket: WebSocket) -> None:
    """Core WebSocket handler for audio streaming and state machine management."""
    await websocket.accept()
    voice_service = get_voice_service()

    current_state = "WAKE_LISTENING"
    current_session_id: str | None = None

    # Buffers (strictly in-memory bytearrays; no recordings stored on disk)
    wake_buffer = bytearray()
    speech_buffer = bytearray()
    vad_buffer = bytearray()

    speech_started = False
    record_start_time = 0.0
    last_speech_time = 0.0

    logger.info("Client connected to voice WebSocket.")
    await websocket.send_json({
        "type": "state_change",
        "state": current_state,
        "message": "Connected to Jarvis Voice. Listening for 'Hey Jarvis'.",
    })

    try:
        while True:
            msg = await websocket.receive()

            if msg["type"] == "websocket.disconnect":
                break

            # Handle JSON control frames from client
            if "text" in msg and msg["text"]:
                try:
                    data = json.loads(msg["text"])
                    event_type = data.get("type", "")

                    if event_type == "set_session":
                        current_session_id = data.get("session_id")
                        logger.info("Voice session set to: %s", current_session_id)

                    elif event_type == "mute":
                        current_state = "MUTED"
                        wake_buffer.clear()
                        speech_buffer.clear()
                        vad_buffer.clear()
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Microphone muted.",
                        })

                    elif event_type == "unmute":
                        current_state = "WAKE_LISTENING"
                        wake_buffer.clear()
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Listening for 'Hey Jarvis'.",
                        })

                    elif event_type in ("emergency_stop", "stop_speaking"):
                        logger.info("Emergency stop triggered by client.")
                        wake_buffer.clear()
                        speech_buffer.clear()
                        vad_buffer.clear()
                        current_state = "WAKE_LISTENING"
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Stopped. Listening for 'Hey Jarvis'.",
                        })

                    elif event_type in ("tts_completed", "resume"):
                        # Handshake: Client finished speaking assistant reply, resuming standby
                        wake_buffer.clear()
                        speech_buffer.clear()
                        vad_buffer.clear()
                        current_state = "WAKE_LISTENING"
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Standing by. Listening for 'Hey Jarvis'.",
                        })

                    elif event_type == "ping":
                        await websocket.send_json({"type": "pong"})

                except json.JSONDecodeError:
                    logger.warning("Received invalid JSON on voice WebSocket: %s", msg["text"])
                continue

            # Handle binary PCM audio frames from client
            if "bytes" in msg and msg["bytes"]:
                raw_bytes = msg["bytes"]

                # In MUTED, PROCESSING, or SPEAKING states, ignore audio to eliminate loopback
                if current_state in ("MUTED", "PROCESSING", "SPEAKING"):
                    continue

                if current_state == "WAKE_LISTENING":
                    wake_buffer.extend(raw_bytes)
                    # 1,280 samples = 2,560 bytes = 80ms at 16kHz 16-bit mono
                    while len(wake_buffer) >= 2560:
                        frame = bytes(wake_buffer[:2560])
                        del wake_buffer[:2560]

                        detected, score = voice_service.predict_wake_word(frame)
                        if detected:
                            logger.info("Wake word triggered! (score=%.3f)", score)
                            await websocket.send_json({
                                "type": "wake_detected",
                                "score": score,
                            })

                            # Transition immediately to RECORDING
                            current_state = "RECORDING"
                            wake_buffer.clear()
                            speech_buffer.clear()
                            vad_buffer.clear()
                            speech_started = False
                            record_start_time = time.monotonic()
                            last_speech_time = record_start_time

                            await websocket.send_json({
                                "type": "state_change",
                                "state": current_state,
                                "message": "Listening for your command...",
                            })
                            break

                elif current_state == "RECORDING":
                    speech_buffer.extend(raw_bytes)
                    vad_buffer.extend(raw_bytes)

                    # Check VAD on 30ms frames (480 samples = 960 bytes)
                    while len(vad_buffer) >= 960:
                        vad_frame = bytes(vad_buffer[:960])
                        del vad_buffer[:960]

                        if voice_service.is_speech_frame(vad_frame):
                            speech_started = True
                            last_speech_time = time.monotonic()

                    now = time.monotonic()
                    silence_duration = now - last_speech_time
                    total_recording_time = now - record_start_time

                    # Completion trigger 1: User spoke and paused for SILENCE_TIMEOUT_SECONDS
                    # Completion trigger 2: User reached MAX_RECORDING_SECONDS safeguard
                    if (speech_started and silence_duration >= SILENCE_TIMEOUT_SECONDS) or (
                        total_recording_time >= MAX_RECORDING_SECONDS
                    ):
                        logger.info(
                            "End of speech detected (speech_started=%s, silence=%.2fs, total=%.2fs)",
                            speech_started,
                            silence_duration,
                            total_recording_time,
                        )

                        # Transition to TRANSCRIBING
                        current_state = "TRANSCRIBING"
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Transcribing speech...",
                        })

                        audio_to_transcribe = bytes(speech_buffer)
                        speech_buffer.clear()
                        vad_buffer.clear()

                        transcript, stt_latency = await voice_service.transcribe_pcm(audio_to_transcribe)

                        if not transcript or not transcript.strip():
                            logger.info("Transcription yielded empty text; returning to standby.")
                            await websocket.send_json({
                                "type": "empty_speech",
                                "message": "No intelligible speech detected.",
                            })
                            current_state = "WAKE_LISTENING"
                            await websocket.send_json({
                                "type": "state_change",
                                "state": current_state,
                                "message": "Listening for 'Hey Jarvis'.",
                            })
                            continue

                        await websocket.send_json({
                            "type": "transcription",
                            "text": transcript,
                            "latency_ms": stt_latency,
                        })

                        # Transition to PROCESSING
                        current_state = "PROCESSING"
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Jarvis is processing your request...",
                        })

                        # Generate unique session ID if not set
                        if not current_session_id:
                            current_session_id = f"voice-{int(time.time())}"

                        llm_start = time.perf_counter()
                        session_factory = get_session_factory()
                        async with session_factory() as db:
                            chat_service = ChatService(
                                db=db,
                                ollama_service=get_ollama_service(),
                            )
                            chat_res = await chat_service.process_chat(
                                session_id=current_session_id,
                                user_message=transcript,
                            )
                        llm_latency = (time.perf_counter() - llm_start) * 1000.0

                        logger.info(
                            "Voice turn complete: STT=%.1fms, LLM=%.1fms. Reply: '%s'",
                            stt_latency,
                            llm_latency,
                            chat_res.reply[:50],
                        )

                        # Kokoro TTS Synthesis (if enabled)
                        audio_b64: str | None = None
                        tts_latency: float | None = None
                        settings = get_settings()

                        if settings.ENABLE_KOKORO_TTS:
                            try:
                                kokoro_service = get_kokoro_service(settings)
                                wav_bytes, tts_lat = await kokoro_service.synthesize(
                                    chat_res.reply,
                                    voice=settings.KOKORO_VOICE,
                                    speed=settings.KOKORO_SPEED,
                                )
                                audio_b64 = base64.b64encode(wav_bytes).decode("ascii")
                                tts_latency = tts_lat
                            except Exception as exc:
                                logger.warning(
                                    "Kokoro TTS generation failed; proceeding with text-only reply: %s",
                                    exc,
                                )

                        # Transition to SPEAKING
                        current_state = "SPEAKING"
                        response_payload: dict[str, Any] = {
                            "type": "chat_response",
                            "reply": chat_res.reply,
                            "user_message": transcript,
                            "session_id": chat_res.session_id,
                            "model": chat_res.model,
                            "created_at": chat_res.created_at.isoformat(),
                            "metrics": {
                                "stt_latency_ms": stt_latency,
                                "llm_latency_ms": llm_latency,
                            },
                        }
                        if audio_b64:
                            response_payload["audio"] = audio_b64
                            response_payload["audio_mime"] = "audio/wav"
                            response_payload["voice"] = settings.KOKORO_VOICE
                            if tts_latency is not None:
                                response_payload["metrics"]["tts_latency_ms"] = tts_latency

                        await websocket.send_json(response_payload)
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Speaking response...",
                        })

                    # Timeout: Wake word fired, but no user speech within 4 seconds
                    elif not speech_started and total_recording_time >= INITIAL_SPEECH_TIMEOUT_SECONDS:
                        logger.info("No speech detected within %.1fs timeout; returning to standby.", INITIAL_SPEECH_TIMEOUT_SECONDS)
                        speech_buffer.clear()
                        vad_buffer.clear()
                        current_state = "WAKE_LISTENING"
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Listening timeout. Listening for 'Hey Jarvis'.",
                        })

    except WebSocketDisconnect:
        logger.info("Voice WebSocket disconnected normally.")
    except Exception as exc:
        logger.error("Error in voice WebSocket handler: %s", exc, exc_info=True)
        try:
            await websocket.send_json({"type": "error", "message": "Internal voice processing error."})
        except Exception:
            pass


@router.websocket("/ws/voice")
async def voice_websocket_endpoint(
    websocket: WebSocket,
    ticket: str | None = Query(default=None),
) -> None:
    """Primary WebSocket endpoint for voice assistant audio and events."""
    if not await verify_websocket_ticket(websocket, ticket):
        return
    await handle_voice_websocket(websocket)


@router.websocket("/api/ws/voice")
async def voice_websocket_alias(
    websocket: WebSocket,
    ticket: str | None = Query(default=None),
) -> None:
    """Alias WebSocket endpoint matching /api prefix."""
    if not await verify_websocket_ticket(websocket, ticket):
        return
    await handle_voice_websocket(websocket)

