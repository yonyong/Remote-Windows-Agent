@echo off
setlocal EnableExtensions

rem Usage:
rem   scripts\restart-dev.bat        -> stop all, start control-plane, wait 8787, agent, frontend
rem   scripts\restart-dev.bat -f     -> stop frontend ports then start frontend only
rem   scripts\restart-dev.bat -b     -> stop backend port, start control-plane, wait 8787

set ARG=%~1

if not "%~2"=="" (
  echo Too many arguments.
  exit /b 2
)

if "%ARG%"=="" goto DO_ALL
if /I "%ARG%"=="-f" goto DO_F
if /I "%ARG%"=="-b" goto DO_B
echo Unknown arg: %ARG%
exit /b 2

:DO_ALL
call "%~dp0stop-dev.bat"
goto START_ALL

:DO_F
call "%~dp0stop-dev.bat" -f
goto START_F

:DO_B
call "%~dp0stop-dev.bat" -b
goto START_B

:START_ALL
set ROOT=%~dp0..
for %%I in ("%ROOT%") do set ROOT=%%~fI
echo === Starting control-plane
start "control-plane" /D "%ROOT%\control-plane" cmd /k npm run dev

echo === Waiting for port 8787 (control-plane)
call :waitForListen 8787 60
if errorlevel 1 exit /b 1

echo === Starting agent
start "agent" /D "%ROOT%\agent" cmd /k npm run dev
timeout /t 1 /nobreak >nul
echo === Starting frontend
start "frontend" /D "%ROOT%\frontend" cmd /k npm run dev -- --host
goto DONE

:START_B
set ROOT=%~dp0..
for %%I in ("%ROOT%") do set ROOT=%%~fI
echo === Starting control-plane
start "control-plane" /D "%ROOT%\control-plane" cmd /k npm run dev

echo === Waiting for port 8787 (control-plane)
call :waitForListen 8787 60
if errorlevel 1 exit /b 1
goto DONE

:START_F
set ROOT=%~dp0..
for %%I in ("%ROOT%") do set ROOT=%%~fI
echo === Starting frontend
start "frontend" /D "%ROOT%\frontend" cmd /k npm run dev -- --host
goto DONE

:DONE
echo Done. New windows were opened for dev servers (where applicable).
exit /b 0

rem ---------------------------------------------------------------------------
rem Wait until netstat shows LISTENING on TCP port %1 (max %2 seconds).
rem ---------------------------------------------------------------------------
:waitForListen
set PORT=%~1
set MAX=%~2
set N=0
:wfloop
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>nul
if %ERRORLEVEL%==0 (
  echo Port %PORT% is listening.
  exit /b 0
)
set /a N=N+1
if %N% GEQ %MAX% (
  echo Timeout: nothing is listening on port %PORT% after %MAX% seconds.
  echo Check the control-plane window for errors.
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wfloop
