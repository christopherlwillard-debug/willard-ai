@echo off
title Willard Media Center
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launcher\start.ps1"
if errorlevel 1 (
  echo.
  echo Willard Media Center could not start.
  echo Check the logs in "%~dp0logs".
  pause
)
