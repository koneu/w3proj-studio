@echo off
rem Sets up a Windows machine to build, run and test W3Proj Studio: the counterpart of scripts/setup-linux.sh.
rem
rem   scripts\setup-windows.bat               install what's missing (through winget; may ask for admin rights)
rem   scripts\setup-windows.bat --check       only report what's there and what's missing; changes nothing
rem   scripts\setup-windows.bat --game PATH   use this Warcraft III folder (else the newest install found)
rem
rem Safe to run again. The work is done by setup-windows.ps1 next to this file; this only starts it with an execution
rem policy that lets it run (for this one process, nothing is changed on the machine).

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1" %*
exit /b %ERRORLEVEL%
