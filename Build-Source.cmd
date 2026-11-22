@echo off
setlocal
if "%~1"=="" (
  echo Usage: Build-Source.cmd "path to the extracted Windows release"
  exit /b 2
)
pushd "%~dp0MMUSEOPS"
if errorlevel 1 exit /b 1
call npm.cmd ci --ignore-scripts --no-audit --no-fund
set "MMUSE_BUILD_STATUS=%errorlevel%"
popd
if not "%MMUSE_BUILD_STATUS%"=="0" exit /b %MMUSE_BUILD_STATUS%
node.exe "%~dp0build-source.cjs" "%~f1"
exit /b %errorlevel%
