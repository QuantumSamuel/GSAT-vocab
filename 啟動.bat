@echo off
rem ------------------------------------------------------------
rem Start local server for vocab 2.0 and open the browser.
rem Close the "vocab-2.0-server" window to stop the server.
rem ------------------------------------------------------------
cd /d "%~dp0"
start "vocab-2.0-server" cmd /k python -m http.server 8000
timeout /t 1 /nobreak >nul
start "" "http://localhost:8000"
