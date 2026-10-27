@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [*] Creating virtual environment...
    python -m venv .venv
    if errorlevel 1 (
        echo [x] Failed. Install Python 3.11+ and make sure "python" is on PATH.
        pause
        exit /b 1
    )
)

echo [*] Installing dependencies...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt -i https://pypi.org/simple
if errorlevel 1 (
    echo [x] pip install failed.
    pause
    exit /b 1
)

echo [ok] Done. Double-click run.bat to start the pet.
pause
