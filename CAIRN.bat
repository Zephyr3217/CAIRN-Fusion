@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo CAIRN is not set up yet. Running setup...
  call scripts\setup_windows.bat
)
call .venv\Scripts\activate.bat
python run_cairn.py
