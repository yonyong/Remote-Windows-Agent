<#
.SYNOPSIS
  Stop local dev processes for this repo (by listening ports).

.DESCRIPTION
  No args: frontend (Vite) + control-plane (8787) + Agent (node heuristic)
  -f: frontend only (ports 5173-5176)
  -b: control-plane only (8787)

  From repo root:
    powershell -ExecutionPolicy Bypass -File .\scripts\stop-dev.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\stop-dev.ps1 -f
    powershell -ExecutionPolicy Bypass -File .\scripts\stop-dev.ps1 -b
#>
param(
  [switch]$f,
  [switch]$b
)

$ErrorActionPreference = 'SilentlyContinue'

$repoRoot = Split-Path $PSScriptRoot -Parent
$agentPathPattern = [regex]::Escape($repoRoot) + '[\\/]agent'

function Stop-ListenersOnPorts {
  param([int[]]$Ports)
  foreach ($port in $Ports) {
    $pids = @(
      Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique
    )
    foreach ($procId in $pids) {
      if ($procId -and $procId -gt 0) {
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped PID=$procId (listen port $port)"
      }
    }
  }
}

function Stop-AgentNodeProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match $agentPathPattern) } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host "Stopped Agent-related node PID=$($_.ProcessId)"
    }
}

$all = (-not $f) -and (-not $b)
$doFront = $all -or $f
$doBack = $all -or $b

if ($doFront) {
  Write-Host '>>> Stop frontend (Vite ports 5173-5176)'
  Stop-ListenersOnPorts @(5173, 5174, 5175, 5176)
}

if ($doBack) {
  Write-Host '>>> Stop control-plane (8787)'
  Stop-ListenersOnPorts @(8787)
}

if ($all) {
  Write-Host '>>> Stop Agent (node.exe cmdline matches .../agent)'
  Stop-AgentNodeProcesses
}

Write-Host 'Done.'
