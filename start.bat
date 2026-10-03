@echo off
rem Double-click launcher for Windows; the work happens in scripts\start.mjs.
cd /d "%~dp0"
title Pegasus
node scripts\start.mjs %*
if errorlevel 1 pause
