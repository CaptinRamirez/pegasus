@echo off
rem Double-click launcher for the campaign on Windows: paper trading on the pot's own paper account (data\paper-campaign.json), the campaign enabled. See scripts\start.mjs.
cd /d "%~dp0"
title Pegasus (campaign)
node scripts\start.mjs --campaign %*
if errorlevel 1 pause
