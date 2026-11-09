#!/usr/bin/env bash
set -e

# PROJECT JARVIS - Local Development Startup (macOS)
cd "$(dirname "$0")/.."

echo "====================================================================="
echo "PROJECT JARVIS - Development Server (macOS)"
echo "====================================================================="

# Check virtual environment
if [ ! -d ".venv" ] && [ ! -d "venv" ]; then
    echo "[Creating virtual environment .venv using python3...]"
    python3 -m venv .venv
fi

if [ -d ".venv" ]; then
    source .venv/bin/activate
elif [ -d "venv" ]; then
    source venv/bin/activate
fi

echo "[Verifying dependencies...]"
pip install -q --upgrade pip
pip install -q -r requirements.txt

echo "[Starting Jarvis backend on http://0.0.0.0:8000...]"
exec uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
