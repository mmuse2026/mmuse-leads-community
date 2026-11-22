@echo off
setlocal
cd /d "%~dp0"
"%~dp0node.exe" "%~dp0community-launch.cjs" %*
