@echo off

:: Open Chrome tabs
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --new-window "http://127.0.0.1:5500" "http://127.0.0.1:8000/guns"

:: Launch backend in its own window
start "EFTForge Backend" cmd /k "cd /d %~dp0backend && call venv\Scripts\activate && python reset.py"

:: Launch frontend in its own window
start "EFTForge Frontend" cmd /k "cd /d %~dp0frontend && %~dp0backend\venv\Scripts\python.exe -m http.server 5500"