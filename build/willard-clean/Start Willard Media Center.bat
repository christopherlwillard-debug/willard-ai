@echo off
setlocal
cd /d "%~dp0.."
set "PowerShellExe=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PowerShellExe%" set "PowerShellExe=powershell.exe"
"%PowerShellExe%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0WillardMediaCenter.ps1"
set "ExitCode=%ERRORLEVEL%"
if not "%ExitCode%"=="0" (
  echo.
  echo Willard Media Center could not start. Exit code: %ExitCode%
  echo Check the logs in "%%LOCALAPPDATA%%\Willard Media Center\logs"
  echo.
  pause
)
endlocal
exit /b %ExitCode%