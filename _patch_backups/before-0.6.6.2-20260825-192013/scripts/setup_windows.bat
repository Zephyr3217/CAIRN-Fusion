@echo off
setlocal EnableExtensions
cd /d "%~dp0\.."

echo ============================================
echo CAIRN Fusion 0.6.6 - Windows Setup
echo ============================================
echo Required: Windows 10/11, Python 3.11+ with pip + venv.
echo Browser extension: Chrome, Brave, or Edge (manual Load unpacked).
echo Optional: Obsidian, Ollama.
echo.

set "PY_CMD="
where py >nul 2>nul && set "PY_CMD=py -3"
if not defined PY_CMD (
  where python >nul 2>nul && set "PY_CMD=python"
)
if not defined PY_CMD (
  echo [MISSING] Python was not found.
  echo Install Python 3.11 or newer from python.org and enable the Python launcher/PATH option.
  echo Then run this setup again.
  pause
  exit /b 1
)

%PY_CMD% -c "import sys; raise SystemExit(0 if sys.version_info >= (3,11) else 9)"
if errorlevel 9 (
  echo [MISSING] CAIRN requires Python 3.11 or newer.
  %PY_CMD% --version
  pause
  exit /b 1
)
%PY_CMD% --version

%PY_CMD% -m pip --version >nul 2>nul
if errorlevel 1 (
  echo [FIX] pip is missing. Attempting Python ensurepip...
  %PY_CMD% -m ensurepip --upgrade
  if errorlevel 1 (
    echo [MISSING] pip could not be installed automatically. Repair/reinstall Python with pip enabled.
    pause
    exit /b 1
  )
)

if not exist .venv\Scripts\python.exe (
  echo [SETUP] Creating .venv...
  %PY_CMD% -m venv .venv
  if errorlevel 1 (
    echo [MISSING] Python venv support is unavailable. Repair/reinstall Python with venv support.
    pause
    exit /b 1
  )
)

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
if errorlevel 1 goto :pipfail
pip install -r requirements.txt
if errorlevel 1 goto :pipfail

python -c "import fastapi,uvicorn,watchfiles,markdown_it; print('[OK] Python requirements verified.')"
if errorlevel 1 (
  echo [FAILED] One or more CAIRN Python packages could not be imported.
  pause
  exit /b 1
)

python -m unittest discover -s tests -v
if errorlevel 1 (
  echo Tests failed. Review the output before using CAIRN on important notes.
  pause
  exit /b 1
)

echo.
echo [OK] CAIRN setup complete.
echo Next: run CAIRN.bat, connect a test vault, then Load unpacked browser_extension in Chrome/Brave/Edge.
pause
exit /b 0

:pipfail
echo [FAILED] Python dependencies could not be installed.
echo Check your internet connection, firewall/proxy, then rerun setup_windows.bat.
pause
exit /b 1
