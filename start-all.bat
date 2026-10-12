@echo off
rem Double-click launcher for both stacks in one window on Windows: the paper trading stack (page 5174), then the campaign (page 5175). See scripts\start.mjs.
cd /d "%~dp0"
title Pegasus (paper + campaign)
node scripts\start.mjs --paper --campaign %*
if errorlevel 1 pause
