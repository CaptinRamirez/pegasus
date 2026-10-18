@echo off
rem Double-click launcher for all three stacks in one window on Windows: the paper trading stack (page 5174), the campaign (page 5175), then the Claude auto trader (page 5176). See scripts\start.mjs.
cd /d "%~dp0"
title Pegasus (paper + campaign + trader)
node scripts\start.mjs --paper --campaign --trader %*
if errorlevel 1 pause
