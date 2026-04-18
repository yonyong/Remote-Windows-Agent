@echo off
setlocal EnableExtensions

rem Deletes the local SQLite DB used by control-plane (dev reset).
rem Default file: <repo>/control-plane/control-plane.sqlite (+ WAL sidecars if present).

set ROOT=%~dp0..
for %%I in ("%ROOT%") do set ROOT=%%~fI

set DB=%ROOT%\control-plane\control-plane.sqlite
set WAL=%ROOT%\control-plane\control-plane.sqlite-wal
set SHM=%ROOT%\control-plane\control-plane.sqlite-shm

if exist "%DB%" (
  del /f /q "%DB%"
  echo Deleted "%DB%"
) else (
  echo No file: "%DB%"
)

if exist "%WAL%" del /f /q "%WAL%" & echo Deleted WAL
if exist "%SHM%" del /f /q "%SHM%" & echo Deleted SHM

echo Done. Restart control-plane (or run scripts\restart-dev.bat).
exit /b 0
