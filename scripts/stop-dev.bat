@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Usage:
rem   scripts\stop-dev.bat        -> stop all (frontend + backend + agent)
rem   scripts\stop-dev.bat -f     -> stop frontend only (ports 5173-5176)
rem   scripts\stop-dev.bat -b     -> stop backend only (port 8787)

set STOP_FRONT=0
set STOP_BACK=0
set STOP_ALL=0

if "%~1"=="" (
  set STOP_ALL=1
) else if /I "%~1"=="-f" (
  set STOP_FRONT=1
) else if /I "%~1"=="-b" (
  set STOP_BACK=1
) else (
  echo Unknown arg: %~1
  exit /b 2
)

if %STOP_ALL%==1 (
  set STOP_FRONT=1
  set STOP_BACK=1
)

call :getRepoRoot

if %STOP_FRONT%==1 (
  echo === Stop frontend ^(Vite ports 5173-5176^)
  for %%P in (5173 5174 5175 5176) do call :killPort %%P
)

if %STOP_BACK%==1 (
  echo === Stop backend ^(control-plane port 8787^)
  call :killPort 8787
)

if %STOP_ALL%==1 (
  echo === Stop agent ^(node.exe cmdline contains \agent\^)
  call :killAgentNode
)

echo Done.
exit /b 0

:killPort
set PORT=%~1
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  set FOUND=1
  call :killPid %%a %PORT%
)
if "%FOUND%"=="0" (
  echo - No process is listening on port %PORT%
)
exit /b 0

:killPid
set PID=%~1
set PRT=%~2
if "%PID%"=="" exit /b 0
if defined KILLED_%PID% exit /b 0
set KILLED_%PID%=1
echo - Killing PID %PID% on port %PRT%
taskkill /PID %PID% /F >nul 2>nul
exit /b 0

:killAgentNode
rem wmic is deprecated but still available on many Windows builds.
rem We use it to kill node.exe whose CommandLine includes the repo "\agent\" path.
set FOUND_AGENT=0
for /f "usebackq delims=" %%L in (`wmic process where "Name='node.exe' and CommandLine like '%%%REPO_ROOT_BS%\\agent\\%%'" get ProcessId /value 2^>nul`) do (
  echo %%L | findstr /I "ProcessId=" >nul && (
    for /f "tokens=2 delims==" %%P in ("%%L") do (
      if not "%%P"=="" (
        set FOUND_AGENT=1
        echo - Killing Agent node PID %%P
        taskkill /PID %%P /F >nul 2>nul
      )
    )
  )
)
if "%FOUND_AGENT%"=="0" (
  echo - No Agent-related node.exe process found
)
exit /b 0

:getRepoRoot
rem this .bat lives in scripts\, repo root is its parent.
set REPO_ROOT=%~dp0..
for %%I in ("%REPO_ROOT%") do set REPO_ROOT=%%~fI
rem build backslash-escaped path fragment for WMIC LIKE (needs \\)
set REPO_ROOT_BS=%REPO_ROOT:\=\\%
exit /b 0

