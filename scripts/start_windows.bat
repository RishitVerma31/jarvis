@echo off
setlocal enabledelayedexpansion

echo =====================================================================
echo PROJECT JARVIS - Local AI Assistant Startup (Windows 11)
echo =====================================================================

:: Navigate to project root directory
cd /d "%~dp0\.."

:: Create production directories on D: if accessible
if exist D:\ (
    if not exist "D:\Jarvis" mkdir "D:\Jarvis"
    if not exist "D:\Jarvis\database" mkdir "D:\Jarvis\database"
    if not exist "D:\Jarvis\logs" mkdir "D:\Jarvis\logs"
)

:: 1. Check if virtual environment exists; create if missing using Python 3.14
if not exist .venv (
    echo [.venv not found. Creating virtual environment using Python 3.14...]
    py -3.14 -m venv .venv
    if errorlevel 1 (
        echo.
        echo [ERROR] Failed to create virtual environment with Python 3.14.
        echo Please verify that Python 3.14.10 is installed and py launcher is in PATH.
        echo Download from: https://www.python.org/downloads/
        pause
        exit /b 1
    )
)

:: 2. Activate virtual environment
echo [Activating virtual environment (.venv)...]
call .venv\Scripts\activate.bat
if errorlevel 1 (
    echo [ERROR] Failed to activate .venv.
    pause
    exit /b 1
)

:: 3. Check and install/upgrade dependencies on every launch
echo [Verifying and installing dependencies from requirements.txt...]
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install or verify dependencies.
    pause
    exit /b 1
)

:: 4. Verify local Ollama is running
echo [Verifying Ollama connection on 127.0.0.1:11434...]
curl -s http://127.0.0.1:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo [WARNING] Ollama is not responding on http://127.0.0.1:11434.
    echo Please make sure the Ollama application is running in Windows.
    echo The backend will start, but AI requests will return 503 until Ollama starts.
) else (
    echo [Ollama is online and reachable.]
)

:: 5. Launch FastAPI application on 0.0.0.0:8000
echo.
echo =====================================================================
echo Starting Jarvis Backend on http://0.0.0.0:8000 ...
echo Accessible locally on Windows at http://127.0.0.1:8000
echo Accessible over LAN from MacBook at http://^<windows-lan-ip^>:8000
echo Interactive API Documentation: http://127.0.0.1:8000/docs
echo =====================================================================
echo.

uvicorn backend.main:app --host 0.0.0.0 --port 8000

pause

