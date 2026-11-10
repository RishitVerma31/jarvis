"""Voice WebSocket router for PROJECT JARVIS.

Manages bidirectional real-time audio streaming, wake-word detection,
voice activity detection, speech-to-text, and conversational response dispatch.
"""

import asyncio
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
from backend.services.voice_service import (
    compute_pcm_rms,
    get_voice_service,
    is_exit_command,
    is_valid_transcript,
    validate_audio_recording,
)

logger = logging.getLogger("jarvis.routers.voice")
router = APIRouter(tags=["Voice"])

# Timing constants
SILENCE_TIMEOUT_SECONDS = 1.2
MAX_RECORDING_SECONDS = 15.0
INITIAL_SPEECH_TIMEOUT_SECONDS = 4.0
FOLLOW_UP_TIMEOUT_SECONDS = 5.0


async def handle_voice_websocket(websocket: WebSocket) -> None:
    """Core WebSocket handler for audio streaming and state machine management."""
    await websocket.accept()
    voice_service = get_voice_service()

    current_state = "WAKE_LISTENING"
    current_session_id: str | None = None
    current_turn_id = 0
    processing_task: asyncio.Task[None] | None = None
    follow_up_task: asyncio.Task[None] | None = None
    follow_up_active = False
    follow_up_deadline: float | None = None
    last_acknowledged_turn_id: int | None = None

    # Buffers (strictly in-memory bytearrays; no recordings stored on disk)
    wake_buffer = bytearray()
    speech_buffer = bytearray()
    speech_only_buffer = bytearray()
    vad_buffer = bytearray()

    speech_started = False
    speech_frames_count = 0
    follow_up_speech_frames = 0
    record_start_time = 0.0
    last_speech_time = 0.0

    def _cancel_follow_up_timer() -> None:
        nonlocal follow_up_task
        if follow_up_task and not follow_up_task.done():
            try:
                current = asyncio.current_task()
            except RuntimeError:
                current = None
            if follow_up_task is not current:
                follow_up_task.cancel()
        follow_up_task = None

    def _clear_follow_up() -> None:
        nonlocal follow_up_active, follow_up_deadline, follow_up_speech_frames
        _cancel_follow_up_timer()
        follow_up_active = False
        follow_up_deadline = None
        follow_up_speech_frames = 0

    def _schedule_follow_up_timer(turn_id: int, delay_seconds: float) -> None:
        nonlocal follow_up_task
        _cancel_follow_up_timer()

        async def _timer_runner() -> None:
            nonlocal current_state, follow_up_active, follow_up_deadline, follow_up_speech_frames
            try:
                while True:
                    now = time.monotonic()
                    if follow_up_deadline is None or now >= follow_up_deadline:
                        break
                    remaining = follow_up_deadline - now
                    if remaining <= 0.005:
                        break
                    await asyncio.sleep(remaining)

                if (
                    follow_up_active
                    and current_state == "WAKE_LISTENING"
                    and current_turn_id == turn_id
                ):
                    logger.info("Follow-up window expired (5s). Returning to standby.")
                    follow_up_active = False
                    follow_up_deadline = None
                    follow_up_speech_frames = 0
                    wake_buffer.clear()
                    speech_buffer.clear()
                    speech_only_buffer.clear()
                    vad_buffer.clear()
                    await websocket.send_json({
                        "type": "state_change",
                        "state": "WAKE_LISTENING",
                        "message": "Listening for 'Hey Jarvis'.",
                        "follow_up": False,
                    })
            except asyncio.CancelledError:
                pass

        follow_up_task = asyncio.create_task(_timer_runner())

    def _arm_follow_up(turn_id: int) -> None:
        """Establish the 5-second follow-up window on first valid tts_completed for a turn."""
        nonlocal follow_up_active, follow_up_deadline, follow_up_speech_frames, last_acknowledged_turn_id
        last_acknowledged_turn_id = turn_id
        _cancel_follow_up_timer()
        follow_up_active = True
        follow_up_speech_frames = 0
        now = time.monotonic()
        follow_up_deadline = now + FOLLOW_UP_TIMEOUT_SECONDS
        _schedule_follow_up_timer(turn_id, FOLLOW_UP_TIMEOUT_SECONDS)

    logger.info("Client connected to voice WebSocket.")
    await websocket.send_json({
        "type": "state_change",
        "state": current_state,
        "message": "Connected to Jarvis Voice. Listening for 'Hey Jarvis'.",
    })

    async def _process_turn(turn_id: int, audio_bytes: bytes) -> None:
        nonlocal current_state, current_session_id, follow_up_active, follow_up_speech_frames, follow_up_deadline
        try:
            transcript, stt_latency = await voice_service.transcribe_pcm(audio_bytes)

            if turn_id != current_turn_id:
                logger.info("Discarding turn %d after STT; active turn is %d", turn_id, current_turn_id)
                return

            if not transcript or not is_valid_transcript(transcript):
                logger.info("Transcription yielded empty or invalid text (%r); returning to standby.", transcript)
                await websocket.send_json({
                    "type": "empty_speech",
                    "message": "No intelligible speech detected.",
                })
                now = time.monotonic()
                if follow_up_deadline is not None and now < follow_up_deadline:
                    remaining = follow_up_deadline - now
                    logger.info("Preserving follow-up window: %.2fs remaining.", remaining)
                    follow_up_active = True
                    follow_up_speech_frames = 0
                    _schedule_follow_up_timer(turn_id, remaining)
                    current_state = "WAKE_LISTENING"
                    await websocket.send_json({
                        "type": "state_change",
                        "state": current_state,
                        "message": "Listening for follow-up...",
                        "follow_up": True,
                    })
                else:
                    _clear_follow_up()
                    current_state = "WAKE_LISTENING"
                    await websocket.send_json({
                        "type": "state_change",
                        "state": current_state,
                        "message": "Listening for 'Hey Jarvis'.",
                        "follow_up": False,
                    })
                return

            # Check for explicit voice exit commands
            if is_exit_command(transcript):
                logger.info("Voice exit command recognized: %r. Returning to standby.", transcript)
                await websocket.send_json({
                    "type": "transcription",
                    "text": transcript,
                    "latency_ms": stt_latency,
                })
                _clear_follow_up()
                wake_buffer.clear()
                speech_buffer.clear()
                speech_only_buffer.clear()
                vad_buffer.clear()
                current_state = "WAKE_LISTENING"
                await websocket.send_json({
                    "type": "state_change",
                    "state": current_state,
                    "message": "Standing by. Listening for 'Hey Jarvis'.",
                    "follow_up": False,
                })
                return

            # Valid user command proceeding to LLM -> cancel follow-up deadline
            _clear_follow_up()

            await websocket.send_json({
                "type": "transcription",
                "text": transcript,
                "latency_ms": stt_latency,
            })

            if turn_id != current_turn_id:
                return

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

            if turn_id != current_turn_id:
                logger.info("Discarding turn %d after LLM; active turn is %d", turn_id, current_turn_id)
                return

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

            if turn_id != current_turn_id:
                logger.info("Discarding turn %d after TTS; active turn is %d", turn_id, current_turn_id)
                return

            # Transition to SPEAKING
            current_state = "SPEAKING"
            response_payload: dict[str, Any] = {
                "type": "chat_response",
                "reply": chat_res.reply,
                "user_message": transcript,
                "session_id": chat_res.session_id,
                "model": chat_res.model,
                "created_at": chat_res.created_at.isoformat(),
                "turn_id": turn_id,
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

        except asyncio.CancelledError:
            logger.info("Voice turn processing task cancelled (turn_id=%d).", turn_id)
            raise
        except Exception as exc:
            logger.error("Error in voice turn processing (turn_id=%d): %s", turn_id, exc, exc_info=True)
            if turn_id == current_turn_id:
                _cancel_follow_up()
                current_state = "WAKE_LISTENING"
                try:
                    await websocket.send_json({"type": "error", "message": "Voice processing error."})
                    await websocket.send_json({
                        "type": "state_change",
                        "state": current_state,
                        "message": "Listening for 'Hey Jarvis'.",
                        "follow_up": False,
                    })
                except Exception:
                    pass

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
                        if processing_task and not processing_task.done():
                            processing_task.cancel()
                            processing_task = None
                        _clear_follow_up()
                        current_turn_id += 1
                        current_state = "MUTED"
                        wake_buffer.clear()
                        speech_buffer.clear()
                        speech_only_buffer.clear()
                        vad_buffer.clear()
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Microphone muted.",
                        })

                    elif event_type == "unmute":
                        _clear_follow_up()
                        current_state = "WAKE_LISTENING"
                        wake_buffer.clear()
                        speech_buffer.clear()
                        speech_only_buffer.clear()
                        vad_buffer.clear()
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Listening for 'Hey Jarvis'.",
                        })

                    elif event_type in ("emergency_stop", "stop_speaking"):
                        logger.info("Emergency stop triggered by client.")
                        if processing_task and not processing_task.done():
                            processing_task.cancel()
                            processing_task = None
                        _clear_follow_up()
                        current_turn_id += 1
                        wake_buffer.clear()
                        speech_buffer.clear()
                        speech_only_buffer.clear()
                        vad_buffer.clear()
                        current_state = "WAKE_LISTENING"
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Stopped. Listening for 'Hey Jarvis'.",
                        })

                    elif event_type == "tts_completed":
                        client_turn_id = data.get("turn_id")

                        # 1. Reject missing, non-integer, or bool turn_id
                        if client_turn_id is None or not isinstance(client_turn_id, int) or isinstance(client_turn_id, bool):
                            logger.warning(
                                "Rejecting %s: missing or invalid turn_id (%r)",
                                event_type,
                                client_turn_id,
                            )
                            continue

                        # 2. Reject stale turn IDs
                        if client_turn_id != current_turn_id:
                            logger.info(
                                "Ignoring stale %s for turn %s (current turn: %s)",
                                event_type,
                                client_turn_id,
                                current_turn_id,
                            )
                            continue

                        # 3. Case A: First valid acknowledgement while SPEAKING
                        if current_state == "SPEAKING" and last_acknowledged_turn_id != current_turn_id:
                            wake_buffer.clear()
                            speech_buffer.clear()
                            speech_only_buffer.clear()
                            vad_buffer.clear()
                            current_state = "WAKE_LISTENING"
                            _arm_follow_up(current_turn_id)

                            await websocket.send_json({
                                "type": "state_change",
                                "state": current_state,
                                "message": "Listening for follow-up (5s)...",
                                "follow_up": True,
                                "ack": "tts_completed",
                                "turn_id": client_turn_id,
                            })
                            continue

                        # 4. Case B: Duplicate acknowledgement (or ACK received when not in SPEAKING)
                        # A duplicate must be acknowledge-only:
                        # - Must NOT clear audio buffers
                        # - Must NOT change current_state
                        # - Must NOT cancel or restart active recording
                        # - Must NOT reset, extend, or recreate an expired deadline
                        # - Must NOT alter mute state
                        # - Must NOT interfere with STT or active processing task
                        logger.info(
                            "Duplicate or non-speaking %s for turn %s in state %s (last_ack=%s)",
                            event_type,
                            client_turn_id,
                            current_state,
                            last_acknowledged_turn_id,
                        )

                        # In active recording, transcribing, processing, or muted: acknowledge without mutating state
                        if current_state in ("RECORDING", "TRANSCRIBING", "PROCESSING", "MUTED"):
                            response = {
                                "type": "state_change",
                                "state": current_state,
                                "ack": "tts_completed",
                                "turn_id": client_turn_id,
                            }
                            if current_state == "MUTED":
                                response["message"] = "Microphone muted."
                            await websocket.send_json(response)
                            continue

                        # In idle WAKE_LISTENING: preserve active deadline or reflect standby
                        now = time.monotonic()
                        is_follow_up_still_active = (
                            follow_up_active
                            and follow_up_deadline is not None
                            and now < follow_up_deadline
                        )
                        if is_follow_up_still_active:
                            await websocket.send_json({
                                "type": "state_change",
                                "state": "WAKE_LISTENING",
                                "message": "Listening for follow-up (5s)...",
                                "follow_up": True,
                                "ack": "tts_completed",
                                "turn_id": client_turn_id,
                            })
                        else:
                            await websocket.send_json({
                                "type": "state_change",
                                "state": "WAKE_LISTENING",
                                "message": "Listening for 'Hey Jarvis'.",
                                "follow_up": False,
                                "ack": "tts_completed",
                                "turn_id": client_turn_id,
                            })

                    elif event_type in ("get_state", "sync_state"):
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "turn_id": current_turn_id,
                            "message": f"State sync: {current_state}",
                            "follow_up": follow_up_active,
                        })

                    elif event_type == "ping":
                        await websocket.send_json({"type": "pong"})

                except json.JSONDecodeError:
                    logger.warning("Received invalid JSON on voice WebSocket: %s", msg["text"])
                continue

            # Handle binary PCM audio frames from client
            if "bytes" in msg and msg["bytes"]:
                raw_bytes = msg["bytes"]

                # In MUTED, TRANSCRIBING, PROCESSING, or SPEAKING states, ignore audio to eliminate loopback
                if current_state in ("MUTED", "TRANSCRIBING", "PROCESSING", "SPEAKING"):
                    continue

                if current_state == "WAKE_LISTENING":
                    # 1. Follow-up mode: check for direct speech activation (no wake-word needed)
                    if follow_up_active:
                        vad_buffer.extend(raw_bytes)
                        follow_up_speech_detected = False
                        captured_follow_up_frames = bytearray()

                        while len(vad_buffer) >= 960:
                            vad_frame = bytes(vad_buffer[:960])
                            del vad_buffer[:960]
                            is_speech = voice_service.is_speech_frame(vad_frame)
                            frame_rms = compute_pcm_rms(vad_frame)

                            if is_speech and frame_rms >= 180.0:
                                follow_up_speech_frames += 1
                                captured_follow_up_frames.extend(vad_frame)
                                if follow_up_speech_frames >= 2:
                                    follow_up_speech_detected = True
                                    captured_follow_up_frames.extend(vad_buffer)
                                    vad_buffer.clear()
                                    break
                            else:
                                if follow_up_speech_frames > 0:
                                    follow_up_speech_frames -= 1

                        if follow_up_speech_detected:
                            logger.info("Follow-up speech detected! Suspending timer and recording command.")
                            _cancel_follow_up_timer()
                            follow_up_active = False  # Suspended during recording; deadline preserved
                            current_state = "RECORDING"
                            wake_buffer.clear()
                            speech_buffer.clear()
                            speech_buffer.extend(captured_follow_up_frames)
                            speech_only_buffer.clear()
                            speech_only_buffer.extend(captured_follow_up_frames)
                            vad_buffer.clear()
                            speech_started = True
                            speech_frames_count = follow_up_speech_frames
                            record_start_time = time.monotonic()
                            last_speech_time = record_start_time

                            await websocket.send_json({
                                "type": "state_change",
                                "state": current_state,
                                "message": "Listening for your command...",
                            })
                            continue

                    else:
                        # 2. Wake-word detection (runs ONLY in genuine Standby, NOT during follow-up)
                        wake_buffer.extend(raw_bytes)
                        # 1,280 samples = 2,560 bytes = 80ms at 16kHz 16-bit mono
                        while len(wake_buffer) >= 2560:
                            frame = bytes(wake_buffer[:2560])
                            del wake_buffer[:2560]

                            detected, score = voice_service.predict_wake_word(frame)
                            if detected:
                                logger.info("Wake word triggered! (score=%.3f)", score)
                                _clear_follow_up()
                                await websocket.send_json({
                                    "type": "wake_detected",
                                    "score": score,
                                })

                                # Transition immediately to RECORDING
                                current_state = "RECORDING"
                                wake_buffer.clear()
                                speech_buffer.clear()
                                speech_only_buffer.clear()
                                vad_buffer.clear()
                                speech_started = False
                                speech_frames_count = 0
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
                            speech_only_buffer.extend(vad_frame)
                            frame_rms = compute_pcm_rms(vad_frame)
                            if frame_rms >= 180.0:
                                speech_frames_count += 1
                                if speech_frames_count >= 2:
                                    speech_started = True
                                    last_speech_time = time.monotonic()
                            else:
                                speech_frames_count += 1
                                if speech_frames_count >= 3:
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
                            "End of speech candidate (speech_started=%s, speech_frames=%d, silence=%.2fs, total=%.2fs)",
                            speech_started,
                            speech_frames_count,
                            silence_duration,
                            total_recording_time,
                        )

                        audio_to_transcribe = bytes(speech_buffer)
                        speech_bytes = bytes(speech_only_buffer)
                        recorded_frames_count = speech_frames_count
                        speech_buffer.clear()
                        speech_only_buffer.clear()
                        vad_buffer.clear()

                        # Audio-level validation before running STT/LLM
                        is_valid_audio, reason = validate_audio_recording(
                            audio_to_transcribe,
                            recorded_frames_count,
                            min_speech_frames=4,
                            min_rms=180.0,
                            speech_pcm_bytes=speech_bytes,
                        )

                        if not is_valid_audio:
                            logger.info("Audio validation rejected (%s). Discarding audio.", reason)
                            await websocket.send_json({
                                "type": "empty_speech",
                                "message": "No intelligible speech detected.",
                            })
                            now = time.monotonic()
                            if follow_up_deadline is not None and now < follow_up_deadline:
                                remaining = follow_up_deadline - now
                                logger.info("Preserving follow-up window: %.2fs remaining.", remaining)
                                follow_up_active = True
                                follow_up_speech_frames = 0
                                _schedule_follow_up_timer(current_turn_id, remaining)
                                current_state = "WAKE_LISTENING"
                                await websocket.send_json({
                                    "type": "state_change",
                                    "state": current_state,
                                    "message": f"Listening for follow-up ({remaining:.1f}s)...",
                                    "follow_up": True,
                                })
                            else:
                                _clear_follow_up()
                                current_state = "WAKE_LISTENING"
                                await websocket.send_json({
                                    "type": "state_change",
                                    "state": current_state,
                                    "message": "Listening for 'Hey Jarvis'.",
                                    "follow_up": False,
                                })
                            continue

                        # Valid audio -> transition to TRANSCRIBING
                        current_state = "TRANSCRIBING"
                        current_turn_id += 1
                        turn_id = current_turn_id

                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Transcribing speech...",
                        })

                        # Ensure previous processing task is cancelled if still active
                        if processing_task and not processing_task.done():
                            processing_task.cancel()

                        # Launch asynchronous turn processing task
                        processing_task = asyncio.create_task(_process_turn(turn_id, audio_to_transcribe))

                    # Timeout: Wake word fired, but no user speech within 4 seconds
                    elif not speech_started and total_recording_time >= INITIAL_SPEECH_TIMEOUT_SECONDS:
                        logger.info("No speech detected within %.1fs timeout; returning to standby.", INITIAL_SPEECH_TIMEOUT_SECONDS)
                        speech_buffer.clear()
                        speech_only_buffer.clear()
                        vad_buffer.clear()
                        _clear_follow_up()
                        current_state = "WAKE_LISTENING"
                        await websocket.send_json({
                            "type": "state_change",
                            "state": current_state,
                            "message": "Listening timeout. Listening for 'Hey Jarvis'.",
                            "follow_up": False,
                        })

    except WebSocketDisconnect:
        logger.info("Voice WebSocket disconnected normally.")
    except Exception as exc:
        logger.error("Error in voice WebSocket handler: %s", exc, exc_info=True)
        try:
            await websocket.send_json({"type": "error", "message": "Internal voice processing error."})
        except Exception:
            pass
    finally:
        _clear_follow_up()
        if processing_task and not processing_task.done():
            processing_task.cancel()
            try:
                await processing_task
            except (asyncio.CancelledError, Exception):
                pass
        wake_buffer.clear()
        speech_buffer.clear()
        speech_only_buffer.clear()
        vad_buffer.clear()


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

