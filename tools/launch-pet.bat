@echo off
rem ============================================================
rem Launch the desktop pet with a clean environment.
rem
rem 1. This machine has a global ELECTRON_RUN_AS_NODE=1. Electron
rem    then degrades to plain Node and dies at main.js:32 (app.on).
rem    NOTE: 'set VAR' only PRINTS the variable; you must write
rem    'set "VAR="' to actually delete it.
rem 2. Everything here is ASCII on purpose: the workspace path has
rem    Chinese characters and cmd reads .bat as GBK, so an UTF-8
rem    path in this file would come out garbled. %~dp0 avoids that.
rem ============================================================
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0.."
start "" "node_modules\electron\dist\electron.exe" . --no-sandbox --disable-gpu --disable-gpu-compositing --disable-software-rasterizer
