[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$pidFile = Join-Path $root "data\firmware-workbench.pid.json"

if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
    Write-Host "工作台未在运行。"
    exit 0
}

$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)" -ErrorAction SilentlyContinue
if ($null -eq $process) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Host "工作台进程已不存在,清理 PID 记录。"
    exit 0
}

Stop-Process -Id $record.pid -Force
Remove-Item -LiteralPath $pidFile -Force
Write-Host "打印机固件工作台已停止(PID $($record.pid))。"
