# PROJECT J.A.R.V.I.S.

**PROJECT J.A.R.V.I.S.** (*Just A Rather Very Intelligent System*) is a private, local-first autonomous AI assistant. It executes high-performance local LLM inference via [Ollama](https://ollama.com) on dedicated Windows 11 hardware, stores complete conversation histories perpetually in SQLite, features a real-time hands-free voice assistant pipeline ("Hey Jarvis"), and provides an Iron Man / Stark Industries HUD-themed React 19 web application accessible securely across your private home network or Tailscale mesh.

---

## 1. System Architecture

- **Development Workstation**: Apple Silicon MacBook Air (macOS).
- **Production Server**: Windows 11 Laptop.
  - **Hardware**: AMD Ryzen 7 HS (8C/16T), NVIDIA GeForce RTX 3050 (6GB VRAM), 16GB System RAM.
  - **Local AI Engine**: Ollama running locally at `http://127.0.0.1:11434` (strictly localhost, never exposed externally).
  - **Core LLM**: `qwen2.5:3b` (fully GPU-accelerated with CUDA offload within 6GB VRAM).
- **Voice & Speech Engine (Stage 2.6)**:
  - **Wake Word Detection**: `openWakeWord` running `hey_jarvis_v0.1.onnx` locally on 80ms PCM audio frames.
  - **Voice Activity Detection (VAD)**: WebRTC VAD (Mode 2) with RMS energy gating for responsive start-of-speech and end-of-speech silence detection.
  - **Speech-to-Text (STT)**: `faster-whisper` (`base.en` / `small.en`) running on CPU int8 or CUDA GPU.
  - **Neural Text-to-Speech (TTS)**: `Kokoro-82M` ONNX (`kokoro-v1.0.onnx` + `voices-v1.0.bin`) generating 24kHz studio-quality voice synthesis (`af_bella`).
- **Backend Application**: Python 3.14 + FastAPI (asynchronous, modular architecture).
- **Frontend Application**: React 19, TypeScript, Vite, Tailwind CSS v4, Lucide Icons, Zustand, TanStack Query.
- **Database**: SQLite with async SQLAlchemy (`aiosqlite`), configured at `D:\Jarvis\database\jarvis.db`.
- **Logs**: Rotating file logs at `D:\Jarvis\logs\jarvis.log`.
- **Network Interface**: FastAPI binds to `0.0.0.0:8000` for client devices on the private network (MacBook, iPhone) via Wi-Fi or Tailscale.

```text
┌──────────────────────────────────────┐           ┌────────────────────────────────────────────────────────┐
│      Client (MacBook / iPhone)       │           │              Server (Windows 11 Laptop)                │
│                                      │           │                                                        │
│  React 19 HUD / Voice Assistant Web  │           │  FastAPI Backend (0.0.0.0:8000)                        │
│   http://<windows-lan-ip>:8000       │ ──Wi-Fi──>│    ├── / (Serves Production SPA Frontend)             │
│                                      │  Private  │    ├── /api/health                                     │
│  Dual Channel:                       │  Network  │    ├── /api/chat                                       │
│    • HTTPS / REST API                │    or     │    ├── /api/sessions                                   │
│    • WSS WebSocket PCM Voice Stream  │ Tailscale │    ├── /api/auth/ws-ticket                              │
│                                      │           │    └── /ws/voice (Real-Time Voice Pipeline)            │
└──────────────────────────────────────┘           │           │                                            │
                                                   │           ├─► openWakeWord ("Hey Jarvis")              │
                                                   │           ├─► WebRTC VAD + RMS Gating                  │
                                                   │           ├─► faster-whisper (Local STT)               │
                                                   │           └─► Kokoro-82M ONNX (Local Neural TTS)       │
                                                   │                     │                                  │
                                                   │    ┌────────────────┴───────────────┐                  │
                                                   │    │ Context Builder (Last 10 msgs) │                  │
                                                   │    └────────────────┬───────────────┘                  │
                                                   │                     │                                  │
                                                   │         ┌───────────┴──────────┐                       │
                                                   │         ▼                      ▼                       │
                                                   │  Ollama (127.0.0.1:11434)  SQLite (D:\Jarvis\database) │
                                                   │  Model: qwen2.5:3b         Perpetual Full History      │
                                                   │  (RTX 3050 CUDA Offload)                               │
                                                   └────────────────────────────────────────────────────────┘
```

---

## 2. Key Implemented Features

### 🎙️ Hands-Free Full-Duplex Voice Assistant ("Hey Jarvis")
- **Continuous Wake-Word Detection**: Listens locally for the phrase *"Hey Jarvis"* using openWakeWord with zero cloud dependency.
- **5-Second Continuous Follow-Up Window**: After Jarvis answers, a 5-second follow-up window remains open so you can continue the conversation without repeating the wake word.
- **Acoustic Echo & Feedback Protection**: Automatically mutes the microphone stream during Kokoro TTS playback and wake chime generation (450ms), preventing Jarvis from hearing itself.
- **Standby Cooldown Guard**: Implements a 1.0s refractory cooldown on return to standby, discarding transitional audio packets to eliminate phantom retrigger loops.
- **Voice Exit Commands**: Detects conversational dismissals (*"thank you"*, *"thanks"*, *"bye"*, *"goodbye"*, *"stop"*, *"go to standby"*, *"sleep"*) and returns to idle standby immediately.
- **Live Voice Activity HUD (`VoiceActivityHUD.tsx`)**:
  - Live visual phase badges: `[WAKE WORD DETECTED]`, `[LISTENING TO COMMAND]`, `[TRANSCRIBING SPEECH]`, `[JARVIS PROCESSING]`, `[SPEAKING RESPONSE]`, and `[FOLLOW-UP ACTIVE]`.
  - Real-time animated audio waveform (`VoiceWaveform.tsx`) reflecting microphone energy.
  - Live recognized speech preview (`Heard: "..."`).
  - STT and LLM latency telemetry.
  - One-click Emergency Stop / Abort button.
- **Mobile & iOS Safari Compatibility**: Seamless AudioContext priming on initial user gesture, iOS `play-and-record` AVAudioSession category management, and hybrid Web Speech API fallback.

### 🛡️ Enterprise-Grade Security & Authentication
- **Fail-Secure Startup**: Requires a strong 32+ character `JARVIS_API_KEY` in production before the server will bind to network interfaces.
- **Constant-Time Verification**: Uses `secrets.compare_digest` to prevent timing attacks across `Authorization: Bearer <key>` and `X-API-Key: <key>` headers.
- **Single-Use WebSocket Tickets**: WebSocket handshakes require short-lived (30s TTL) single-use tickets acquired via `/api/auth/ws-ticket`.
- **Passkey Protection Modal**: Frontend gates access with an interactive passkey prompt (`AuthModal.tsx`), with automatic 401 interceptors that clear storage and re-challenge unauthorized clients.
- **Strict CORS Protection**: Wildcard origins (`*`) are strictly blocked in production.

### 💻 Stark Industries Web UI (React 19 + Tailwind CSS v4)
- **Holographic Arc Reactor Welcome Screen**: Multi-ring animated reactor with interactive tactical suggestion cards.
- **Conversational Chat Feed**: Markdown formatting (`react-markdown`, `remark-gfm`), math rendering, and PrismJS syntax-highlighted code blocks with one-click copy.
- **Session Management Drawer**: Persistent sidebar listing historical conversations, session switching, new chat initialization, and session deletion with optimistic UI updates.
- **Real-Time Telemetry Header**: Live status indicators for Backend API, SQLite Database connection, and Ollama model status.

### 🧠 Perpetual Memory & Context Slicing
- Every single message is permanently stored in SQLite (`messages` table).
- Ollama inference receives the latest 10 messages in chronological order, maintaining coherent immediate dialogue without unbounded VRAM growth.

---

## 3. Project Directory Structure

```text
jarvis/
├── .env.example                 # Environment variables template (Windows & macOS presets)
├── .gitignore                   # Excludes venvs, SQLite databases, models cache, logs, and secrets
├── requirements.txt             # Python production dependencies (FastAPI, uvicorn, openwakeword, Kokoro, etc.)
├── pytest.ini                   # Pytest test configuration
├── README.md                    # Setup and operational documentation
├── backend/
│   ├── __init__.py              # Backend package marker
│   ├── main.py                  # FastAPI application entrypoint, lifespan, CORS, static SPA serving
│   ├── config.py                # Pydantic Settings & cross-platform path resolution
│   ├── database.py              # Async SQLite engine, sessionmaker, & auto table creation
│   ├── security.py              # API key verification & single-use WebSocket ticket store
│   ├── models/
│   │   ├── __init__.py          # Models export
│   │   ├── db_models.py         # SQLAlchemy models (SessionModel, MessageModel)
│   │   └── schemas.py           # Pydantic schemas (ChatRequest, ChatResponse, Health, etc.)
│   ├── services/
│   │   ├── __init__.py          # Services export
│   │   ├── ollama_service.py    # Async Ollama HTTP client (/api/chat, /api/tags)
│   │   ├── chat_service.py      # Context windowing (latest 10) & SQLite persistence
│   │   ├── voice_service.py     # Singleton openWakeWord, WebRTC VAD, and faster-whisper STT
│   │   └── kokoro_service.py    # Local Kokoro-82M ONNX neural speech synthesis
│   ├── routers/
│   │   ├── __init__.py          # Routers export
│   │   ├── health.py            # GET /health & GET /api/health
│   │   ├── chat.py              # POST /chat & POST /api/chat
│   │   ├── sessions.py          # GET /sessions, /sessions/{id}, DELETE /sessions/{id}
│   │   ├── auth.py              # POST /auth/ws-ticket & POST /api/auth/ws-ticket
│   │   └── voice.py             # WebSocket /ws/voice & /api/ws/voice (Voice Pipeline)
│   └── utils/
│       ├── __init__.py          # Utilities export
│       └── logger.py            # Dual console and rotating file logger
├── frontend/
│   ├── index.html               # SPA HTML entry point
│   ├── package.json             # Frontend dependencies (React 19, Vite, Tailwind CSS v4, Lucide, Zustand)
│   ├── vite.config.ts           # Vite bundler configuration
│   ├── tsconfig.json            # TypeScript configuration
│   ├── src/
│   │   ├── main.tsx             # React DOM root entry
│   │   ├── App.tsx              # Main layout, auth synchronization, modal gating
│   │   ├── index.css            # Tailwind CSS v4 styles & custom futuristic animations
│   │   ├── components/
│   │   │   ├── auth/            # AuthModal (Passkey clearance prompt)
│   │   │   ├── chat/            # ChatContainer, ChatInput, MessageBubble, CodeBlock, MarkdownView
│   │   │   ├── common/          # StatusBadge
│   │   │   ├── layout/          # Header (telemetry, voice controls), Sidebar (session drawer)
│   │   │   └── voice/           # VoiceControls (Header), VoiceActivityHUD (Chat), VoiceWaveform
│   │   ├── hooks/
│   │   │   ├── useChat.ts       # Chat message dispatch and optimistic cache updates
│   │   │   ├── useHealth.ts     # Periodic health polling via React Query
│   │   │   ├── useSessions.ts   # Session listing and deletion
│   │   │   ├── useVoiceAssistant.ts # Full-duplex WebSocket voice coordinator
│   │   │   ├── useSpeechRecognition.ts # Web Speech API fallback
│   │   │   └── useSpeechSynthesis.ts   # Web Speech API fallback
│   │   ├── services/
│   │   │   ├── apiClient.ts     # Authenticated fetch wrapper with 401 handling
│   │   │   ├── auth.ts          # Passkey storage and authentication event bus
│   │   │   └── voiceSocket.ts   # Resilient WebSocket client with ticket support
│   │   ├── stores/
│   │   │   └── useUIStore.ts    # Global Zustand store (voice state, HUD telemetry, sessions, auth)
│   │   ├── types/               # TypeScript interfaces for API and Voice WebSocket protocols
│   │   └── utils/               # Audio chime synthesizer, audio playback, resamplers, iOS audio session
│   └── tests/                   # Node.js verification tests (voice lifecycle, auth, audio playback)
├── scripts/
│   ├── start_windows.bat        # Windows 11 automated startup script (Python 3.14 + .venv)
│   └── start_mac.sh             # macOS local development runner
└── tests/
    ├── conftest.py              # Pytest async fixtures, in-memory SQLite, & mock Ollama
    ├── test_health.py           # Tests for /health and root status
    ├── test_chat.py             # Tests for /chat, input validation, context windowing, & errors
    ├── test_sessions.py         # Tests for session listings and detailed history
    ├── test_auth.py             # Tests for API key verification & WebSocket tickets
    ├── test_api_routing.py      # Tests for /api route aliases and CORS headers
    ├── test_kokoro.py           # Unit tests for Kokoro-82M neural TTS
    ├── test_voice.py            # Full-duplex voice WebSocket & state machine integration tests
    └── test_ollama_service.py   # Unit tests for Ollama connectivity error handling
```

---

## 4. Windows 11 Production Setup Guide

### Step 4.1: Install Python 3.14
1. Download the Python 3.14 Windows 64-bit installer from [python.org](https://www.python.org/downloads/).
2. Run the installer:
   - Check **"Add python.exe to PATH"**.
   - Check **"Install launcher for all users (recommended)"**.
   - Click **Install Now**.
3. Verify installation in Windows Terminal:
   ```cmd
   py -3.14 --version
   ```

---

### Step 4.2: Install Ollama & Pull `qwen2.5:3b`
1. Download and run the Windows installer from [ollama.com/download/windows](https://ollama.com/download/windows).
2. Open PowerShell or Command Prompt and download the model:
   ```cmd
   ollama pull qwen2.5:3b
   ```
3. Verify RTX 3050 GPU offload:
   ```cmd
   ollama run qwen2.5:3b "Hello Jarvis, system check."
   ```
   In a separate terminal, run `nvidia-smi` to confirm `ollama_llama_server.exe` has allocated VRAM on your RTX 3050.

---

### Step 4.3: Set Up Project Directory Structure
Create directories on the `D:` drive:
```powershell
New-Item -ItemType Directory -Force -Path "D:\Jarvis\app"
New-Item -ItemType Directory -Force -Path "D:\Jarvis\database"
New-Item -ItemType Directory -Force -Path "D:\Jarvis\logs"
New-Item -ItemType Directory -Force -Path "D:\Jarvis\models"
New-Item -ItemType Directory -Force -Path "D:\Jarvis\models\kokoro"
New-Item -ItemType Directory -Force -Path "D:\Jarvis\models\openwakeword"
```

Clone your repository into `D:\Jarvis\app`:
```powershell
cd D:\Jarvis\app
git clone <YOUR_REPO_URL> .
```

---

### Step 4.4: Configure `.env` and Security Secret
Create your `.env` configuration file:
```powershell
Copy-Item .env.example .env
```
Open `D:\Jarvis\app\.env` in a text editor and configure:
```ini
ENVIRONMENT=production
HOST=0.0.0.0
PORT=8000

# Required: Generate a secure random 32+ character key
JARVIS_API_KEY=YOUR_SECURE_RANDOM_SECRET_KEY_32_CHARS_MINIMUM

# Explicit allowed CORS origins (comma-separated, no wildcard)
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000,http://<windows-lan-ip>:8000

# Production paths
JARVIS_DB_PATH=D:\Jarvis\database\jarvis.db
JARVIS_LOG_PATH=D:\Jarvis\logs\jarvis.log
JARVIS_MODELS_PATH=D:\Jarvis\models

# Local Ollama endpoint
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:3b

# Voice Assistant & Speech Settings
WAKE_WORD_MODEL=hey_jarvis_v0.1
WAKE_WORD_THRESHOLD=0.7
WAKE_WORD_COOLDOWN_SECONDS=2.0
WHISPER_MODEL_SIZE=base.en
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8

# Kokoro-82M Neural TTS
ENABLE_KOKORO_TTS=true
KOKORO_MODEL_PATH=D:\Jarvis\models\kokoro\kokoro-v1.0.onnx
KOKORO_VOICES_PATH=D:\Jarvis\models\kokoro\voices-v1.0.bin
KOKORO_VOICE=af_bella
KOKORO_SPEED=1.0
```

> [!NOTE]
> Voice models (`hey_jarvis_v0.1.onnx`, `melspectrogram.onnx`, `embedding_model.onnx`) and Kokoro models (`kokoro-v1.0.onnx`, `voices-v1.0.bin`) will be downloaded automatically on first startup into `D:\Jarvis\models` if not already present.

---

### Step 4.5: Configure Windows Defender Firewall
Allow MacBook and iPhone access over the private network:
1. Verify your network is set to **Private** in Windows **Settings > Network & internet > Wi-Fi**.
2. Open **PowerShell as Administrator** and execute:
   ```powershell
   New-NetFirewallRule -DisplayName "Jarvis Backend Port 8000" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow -Profile Private
   ```

---

### Step 4.6: Build the Frontend (SPA)
Build the production static assets on Windows or your development machine:
```cmd
cd D:\Jarvis\app\frontend
npm install
npm run build
```
The compiled assets will output into `frontend/dist`. FastAPI automatically mounts and serves these files at `http://0.0.0.0:8000/`.

---

### Step 4.7: Start the Server on Windows
Double-click:
```
D:\Jarvis\app\scripts\start_windows.bat
```
Or execute from Command Prompt / PowerShell:
```cmd
cd D:\Jarvis\app
scripts\start_windows.bat
```

The script will automatically:
1. Initialize `.venv` with Python 3.14.
2. Install and update dependencies from `requirements.txt`.
3. Verify local Ollama is active on `127.0.0.1:11434`.
4. Launch Uvicorn bound to `http://0.0.0.0:8000`.

---

## 5. Connecting from Clients (MacBook & iPhone)

### Step 5.1: Find the Windows Host IP
On the Windows laptop, run `ipconfig` and note your IPv4 Address (e.g. `192.168.1.50`), or use your **Tailscale IP**.

### Step 5.2: Open in Browser
On your MacBook or iPhone, navigate to:
```
http://<windows-lan-ip>:8000
```
*(or via Tailscale: `http://<tailscale-ip>:8000`)*

1. **Clearance Passkey Prompt**: Enter the `JARVIS_API_KEY` you configured in `.env`. The key is saved securely in your browser's local storage.
2. **Enable Voice Mode**: Click the **"Voice Mode"** button in the header. When prompted, grant microphone access.
3. **Hands-Free Operation**: Say *"Hey Jarvis, what is the theory of relativity?"*. Watch the Voice Activity HUD react in real-time as Jarvis transcribes your speech, processes the prompt, and vocalizes the reply via Kokoro neural audio.
4. **Follow-Up**: After Jarvis finishes speaking, notice the HUD switch to `[FOLLOW-UP ACTIVE (5s)]`. Simply ask your next question directly without repeating the wake word.

---

## 6. Local Development on macOS

```bash
# 1. Setup Python environment
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# 2. Setup Node environment
cd frontend
npm install
cd ..

# 3. Automatic macOS Path Fallbacks
# On macOS, paths automatically redirect from D:\Jarvis to ./data/
# Database: ./data/database/jarvis.db
# Logs:     ./data/logs/jarvis.log
# Models:   ./data/models/

# 4. Run automated test suites
pytest -v                        # Backend pytest suite (113+ tests)
npm test --prefix frontend       # Frontend node verification suite (106+ tests)

# 5. Run development servers
./scripts/start_mac.sh           # Backend server on http://localhost:8000
npm run dev --prefix frontend    # Frontend Vite dev server on http://localhost:5173
```

---

## 7. API Reference

All routes are available both with the `/api` prefix and as top-level paths for backwards compatibility.

| Method | Endpoint | Auth Required | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | No | Serves the production Single Page Application (HTML). |
| `GET` | `/api/status` | No | Root service status and version information. |
| `GET` | `/api/health` | No | Verifies FastAPI, SQLite database, and Ollama connectivity. |
| `POST` | `/api/auth/ws-ticket` | Yes (`Bearer` / `X-API-Key`) | Generates a single-use ticket (30s TTL) for WebSocket connection. |
| `POST` | `/api/chat` | Yes (`Bearer` / `X-API-Key`) | Sends a message, builds context, queries Ollama, persists history. |
| `GET` | `/api/sessions` | Yes (`Bearer` / `X-API-Key`) | Lists all stored sessions with message counts and timestamps. |
| `GET` | `/api/sessions/{id}`| Yes (`Bearer` / `X-API-Key`) | Retrieves complete chronological message history for a session. |
| `DELETE`| `/api/sessions/{id}`| Yes (`Bearer` / `X-API-Key`) | Deletes a conversation session and cascades all messages. |
| `WS` | `/ws/voice` | Ticket (`?ticket=...`) | Duplex PCM audio streaming, wake detection, STT, and Kokoro TTS. |

---

## 8. Voice Assistant Protocol Specification (`/ws/voice`)

### Client-to-Server Messages
- **Binary Frames**: Raw 16-bit little-endian mono PCM audio sampled at 16,000 Hz.
- **Control JSON**:
  - `{"type": "set_session", "session_id": "session-123"}`: Associates the voice stream with a chat session.
  - `{"type": "tts_completed", "turn_id": 1}`: Acknowledges client finished audio playback, arming the 5-second follow-up window.
  - `{"type": "emergency_stop"}`: Immediately halts active speech synthesis, discards pending turn tasks, and resets to standby.
  - `{"type": "mute"}` / `{"type": "unmute"}`: Toggles microphone audio processing.
  - `{"type": "get_state"}`: Requests authoritative backend state synchronization.
  - `{"type": "ping"}`: Heartbeat check; server responds with `{"type": "pong"}`.

### Server-to-Client Messages
- `{"type": "wake_detected", "score": 0.85}`: Broadcast when *"Hey Jarvis"* is recognized.
- `{"type": "state_change", "state": "RECORDING", "message": "Listening for your command...", "turn_id": 1}`: Pipeline state transition.
- `{"type": "transcription", "text": "What time is it?", "latency_ms": 320.5}`: Real-time Whisper STT transcript.
- `{"type": "chat_response", "reply": "...", "audio": "<base64_wav>", "turn_id": 1, "metrics": {...}}`: LLM reply text, metrics, and Kokoro 24kHz WAV audio.
- `{"type": "empty_speech", "message": "No intelligible speech detected."}`: Triggered when noise or silence is discarded.
- `{"type": "error", "message": "..."}`: Error notification.

---

## 9. Troubleshooting

- **Ollama Returns 503 (`Ollama service is unreachable`)**:
  - Verify Ollama is running in the Windows system tray or run `ollama serve`.
- **Ollama Returns 502 (`Model 'qwen2.5:3b' was not found`)**:
  - Run `ollama pull qwen2.5:3b` in Command Prompt or PowerShell.
- **Passkey Unauthorized (401 Error in UI)**:
  - Check that the passkey entered in the UI matches `JARVIS_API_KEY` in `D:\Jarvis\app\.env`.
  - Click the shield badge in the header to re-enter your passkey.
- **Microphone Loop / Echo / Wake Retriggering**:
  - Ensure your system speakers are not turned to maximum volume right next to a high-gain microphone.
  - The built-in 450ms wake mute and 1.0s standby cooldown automatically discard transitional audio.
- **MacBook Cannot Connect to Windows (`Connection refused` or timeout)**:
  - Verify both machines are on the same Wi-Fi network and the network profile is set to **Private**.
  - Re-run the PowerShell firewall command from Step 4.5.
  - If using Tailscale, ensure both devices are active in the Tailscale admin console and ping the Windows Tailscale IP.
