@echo off
rem Double-click launcher for the Claude auto trader on Windows: paper trading on the trader's own paper account (data\paper-trader.json), the trader enabled. See scripts\start.mjs and docs\proposals\claude-auto-trader.md.
cd /d "%~dp0"
title Pegasus (trader)
node scripts\start.mjs --trader %*
if errorlevel 1 pause
