# PROJECT JARVIS — PHASE 1

PROJECT JARVIS is a private, local-first AI assistant backend. It runs local LLM inference via [Ollama](https://ollama.com) on Windows 11 hardware, stores complete conversation histories permanently in SQLite, and provides a modular, async FastAPI interface accessible over your local home network.

---

## 1. System Architecture

- **Development Workstation**: Apple Silicon MacBook Air (macOS).
- **Production Server**: Windows 11 Laptop.
  - **Hardware**: AMD Ryzen 7 HS, NVIDIA GeForce RTX 3050 (6GB VRAM), 16GB RAM.
  - **Local AI Engine**: Ollama running on Windows bound to `http://127.0.0.1:11434` (strictly localhost, never exposed externally).
  - **Initial AI Model**: `qwen2.5:3b` (fully GPU-accelerated with CUDA offload within 6GB VRAM).
- **Backend Application**: Python 3.14.10 + FastAPI (asynchronous, modular).
- **Database**: SQLite with async SQLAlchemy (`aiosqlite`), configured at `D:\Jarvis\database\jarvis.db`.
- **Logs**: Rotating file logs at `D:\Jarvis\logs\jarvis.log`.
- **Network Interface**: FastAPI binds to `0.0.0.0:8000` so client devices on the private home Wi-Fi (such as the MacBook) can access it securely.

```
┌─────────────────────────────────┐           ┌────────────────────────────────────────────────────────┐
│     Client (MacBook Air)        │           │              Server (Windows 11 Laptop)                │
│                                 │           │                                                        │
│  Browser / Curl / Future UI     │           │  FastAPI Backend (0.0.0.0:8000)                        │
│   http://<windows-lan-ip>:8000  │ ──Wi-Fi──>│    ├── /health                                         │
│                                 │  Private  │    ├── /chat ───────┐                                  │
│                                 │  Network  │    └── /sessions    │                                  │
└─────────────────────────────────┘           │                     │                                  │
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

## 2. Project Directory Structure

```text
jarvis/
├── .env.example                 # Environment variables template (Windows & macOS presets)
├── .gitignore                   # Excludes venvs, SQLite databases, logs, and secrets
├── requirements.txt             # Python dependencies (FastAPI, uvicorn, SQLAlchemy, httpx, etc.)
├── pytest.ini                   # Pytest test configuration
├── README.md                    # Setup and operational documentation
├── backend/
│   ├── __init__.py              # Backend package marker
│   ├── main.py                  # FastAPI application entrypoint, lifespan, & exception handlers
│   ├── config.py                # Pydantic Settings & cross-platform path resolution
│   ├── database.py              # Async SQLite engine, sessionmaker, & auto table creation
│   ├── models/
│   │   ├── __init__.py          # Models export
│   │   ├── db_models.py         # SQLAlchemy models (SessionModel, MessageModel)
│   │   └── schemas.py           # Pydantic schemas (ChatRequest, ChatResponse, Health, etc.)
│   ├── services/
│   │   ├── __init__.py          # Services export
│   │   ├── ollama_service.py    # Async Ollama HTTP client (/api/chat, /api/tags)
│   │   └── chat_service.py      # Context windowing (latest 10) & SQLite persistence
│   ├── routers/
│   │   ├── __init__.py          # Routers export
│   │   ├── health.py            # GET /health
│   │   ├── chat.py              # POST /chat
│   │   └── sessions.py          # GET /sessions & GET /sessions/{session_id}
│   └── utils/
│       ├── __init__.py          # Utilities export
│       └── logger.py            # Dual console and rotating file logger
├── scripts/
│   ├── start_windows.bat        # Windows 11 automated startup script (Python 3.14 + .venv)
│   └── start_mac.sh             # macOS local development runner
└── tests/
    ├── __init__.py              # Tests package marker
    ├── conftest.py              # Pytest async fixtures, in-memory SQLite, & mock Ollama
    ├── test_health.py           # Tests for /health and root status
    ├── test_chat.py             # Tests for /chat, input validation, context windowing, & errors
    ├── test_sessions.py         # Tests for session listings and detailed history
    ├── test_config.py           # Tests for path resolution & defaults
    └── test_ollama_service.py   # Unit tests for Ollama connectivity error handling
```

---

## 3. Windows 11 Production Setup Guide

Follow these exact steps on your Windows 11 laptop.

### Step 3.1: Install Python 3.14.10

1. Download the Python 3.14.10 Windows 64-bit installer from the official website: [python.org](https://www.python.org/downloads/).
2. Run the installer:
   - **Crucial**: Check the box **"Add python.exe to PATH"**.
   - **Crucial**: Check the box **"Install launcher for all users (recommended)"**.
   - Click **Install Now**.
3. Open Windows Terminal (PowerShell or Command Prompt) and verify the installation:
   ```cmd
   py -3.14 --version
   ```
   *Expected output: `Python 3.14.10` (or 3.14.x).*

---

### Step 3.2: Install Ollama & Pull `qwen2.5:3b`

1. Download and run the Windows installer from [ollama.com/download/windows](https://ollama.com/download/windows).
2. Once installed, Ollama runs automatically in the Windows system tray.
3. Open PowerShell or Command Prompt and download the `qwen2.5:3b` model:
   ```cmd
   ollama pull qwen2.5:3b
   ```
4. Verify the model is downloaded and accessible:
   ```cmd
   ollama list
   ```
5. **Verify RTX 3050 CUDA Offload**:
   Run a quick prompt to verify inference uses your RTX 3050 GPU:
   ```cmd
   ollama run qwen2.5:3b "Hello, who are you?"
   ```
   In a separate PowerShell window, check GPU usage:
   ```cmd
   nvidia-smi
   ```
   *You should see the `ollama_llama_server.exe` process allocating memory in the RTX 3050 6GB VRAM.*

---

### Step 3.3: Set Up Project Directory Structure

We will place the application files under `D:\Jarvis\app`, database in `D:\Jarvis\database`, and logs in `D:\Jarvis\logs`.

1. Open PowerShell and create the parent directories:
   ```powershell
   New-Item -ItemType Directory -Force -Path "D:\Jarvis\app"
   New-Item -ItemType Directory -Force -Path "D:\Jarvis\database"
   New-Item -ItemType Directory -Force -Path "D:\Jarvis\logs"
   ```
2. Clone your private GitHub repository into `D:\Jarvis\app`:
   ```powershell
   cd D:\Jarvis\app
   git clone <YOUR_PRIVATE_GITHUB_REPO_URL> .
   ```
3. Create your `.env` configuration file:
   ```powershell
   Copy-Item .env.example .env
   ```
   *(The default `.env.example` is already pre-configured for `D:\Jarvis\database\jarvis.db` and `D:\Jarvis\logs\jarvis.log`.)*

---

### Step 3.4: Configure Windows Defender Firewall (Private Network Only)

To allow your MacBook to communicate with the Jarvis backend over Wi-Fi without exposing the port to public networks or the internet:

1. Verify your current Wi-Fi network profile is set to **Private**:
   - Go to Windows **Settings** > **Network & internet** > **Wi-Fi** > Click your connected network.
   - Ensure **Network profile type** is set to **Private network**.
2. Open **PowerShell as Administrator** and run the following command:
   ```powershell
   New-NetFirewallRule -DisplayName "Jarvis Backend Port 8000" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow -Profile Private
   ```
3. **Important Security Rules**:
   - **DO NOT** set the firewall rule profile to `Public` or `Any`.
   - **DO NOT** configure router port forwarding or UPnP for port 8000 or 11434.
   - Ollama stays bound strictly to `127.0.0.1:11434` and is never exposed directly.

---

### Step 3.5: Start the Backend on Windows

Simply double-click:
```
D:\Jarvis\app\scripts\start_windows.bat
```
Or run from PowerShell/CMD:
```cmd
cd D:\Jarvis\app
scripts\start_windows.bat
```

**What the startup script does automatically:**
1. Verifies if `.venv` exists; if missing, creates it using `py -3.14 -m venv .venv`.
2. Activates `.venv`.
3. Upgrades `pip` and installs/updates all packages from `requirements.txt`.
4. Checks whether local Ollama is active on `127.0.0.1:11434`.
5. Launches Uvicorn on `http://0.0.0.0:8000`.

---

## 4. Connecting from your MacBook (macOS)

### Step 4.1: Find the Windows Laptop's Local IP Address

On the Windows laptop, open Command Prompt and run:
```cmd
ipconfig
```
Look for **IPv4 Address** under your Wi-Fi adapter (e.g., `192.168.1.50`).

### Step 4.2: Test Connectivity from MacBook

Open Terminal on your MacBook and run:

1. **Health Check**:
   ```bash
   curl http://<windows-lan-ip>:8000/health
   ```
   *Expected Response:*
   ```json
   {
     "status": "healthy",
     "backend": "healthy",
     "database": "connected",
     "ollama": {
       "status": "connected",
       "base_url": "http://127.0.0.1:11434",
       "target_model": "qwen2.5:3b",
       "model_available": true,
       "detail": "Ollama is online and target model is ready."
     },
     "timestamp": "2026-11-09T10:30:00Z"
   }
   ```

2. **Send a Chat Message**:
   ```bash
   curl -X POST http://<windows-lan-ip>:8000/chat \
     -H "Content-Type: application/json" \
     -d '{"session_id": "mac-session-1", "message": "Hello Jarvis, are you active?"}'
   ```

3. **Interactive Swagger API Documentation**:
   Open your browser on macOS and navigate to:
   ```
   http://<windows-lan-ip>:8000/docs
   ```

---

## 5. Development on macOS

When developing and running tests locally on macOS:

1. Set up the virtual environment:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install --upgrade pip
   pip install -r requirements.txt
   ```
2. **Automatic macOS Path Fallback**:
   On macOS, the configuration automatically detects that `D:\Jarvis` is not a POSIX path and falls back to:
   - Database: `./data/database/jarvis.db`
   - Logs: `./data/logs/jarvis.log`
   *(Both directories are auto-created and excluded from git).*
3. Run the development server:
   ```bash
   ./scripts/start_mac.sh
   ```
4. Run the automated test suite:
   ```bash
   pytest -v
   ```

---

## 6. Context Window & History Persistence Logic

To ensure the AI model never slows down or runs out of VRAM while preserving every piece of user interaction:

1. **Perpetual SQLite Persistence**:
   - Every user message and every assistant response is stored permanently in the `messages` table.
   - Older messages are **never deleted or truncated** from SQLite.
2. **Context Window Slicing (Latest 10 Messages)**:
   - When preparing the prompt for Ollama `/api/chat`, the backend queries:
     ```sql
     SELECT role, content FROM messages WHERE session_id = :session_id ORDER BY id DESC LIMIT 10;
     ```
   - The 10 most recent messages are reversed into chronological order, and the incoming user message is appended.
   - This provides the model with immediate conversational context without unbounded memory growth.

---

## 7. API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/` | Root service status and documentation links. |
| `GET` | `/health` | Verifies FastAPI, SQLite database, and Ollama connectivity. |
| `POST` | `/chat` | Sends a message, builds context, queries Ollama, persists history. |
| `GET` | `/sessions` | Lists all stored sessions with message counts and timestamps. |
| `GET` | `/sessions/{id}` | Retrieves complete chronological message history for a session. |

### Sample `POST /chat` Request
```json
{
  "session_id": "session-101",
  "message": "Explain how an electric motor works in two sentences."
}
```

### Sample `POST /chat` Response
```json
{
  "session_id": "session-101",
  "reply": "An electric motor works by using electromagnets to convert electrical energy into mechanical motion. When current passes through wire coils inside a magnetic field, the resulting magnetic forces create torque that rotates the central shaft.",
  "model": "qwen2.5:3b",
  "created_at": "2026-11-09T10:35:12.450123Z"
}
```

---

## 8. Troubleshooting

- **Ollama Returns 503 (`Ollama service is unreachable`)**:
  - Check if the Ollama application is running on Windows. Look for the llama icon in the system tray or run `ollama serve`.
- **Ollama Returns 502 (`Model 'qwen2.5:3b' was not found`)**:
  - Run `ollama pull qwen2.5:3b` in PowerShell to download the model.
- **MacBook Cannot Connect to Windows (`Connection refused` or timeout)**:
  - Verify both machines are on the same local Wi-Fi network.
  - Verify the Windows network is set to **Private**.
  - Re-run the PowerShell firewall command from Step 3.4.
  - Verify Windows IP with `ipconfig`.
