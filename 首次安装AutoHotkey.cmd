@echo off
powershell.exe -NoLogo -NoProfile -File "%~dp0install-autohotkey.ps1"
if errorlevel 1 pause
