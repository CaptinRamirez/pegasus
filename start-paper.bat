@echo off
rem Double-click launcher for paper trading on Windows: OKX live prices, a simulated account. See scripts\start.mjs.
cd /d "%~dp0"
title Pegasus (paper)
node scripts\start.mjs --paper %*
if errorlevel 1 pause
