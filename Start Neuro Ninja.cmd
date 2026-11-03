@echo off
title Neuro Ninja
cd /d "%~dp0"
echo Starting Neuro Ninja ... keep this window open while you play.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Open
if errorlevel 1 pause
