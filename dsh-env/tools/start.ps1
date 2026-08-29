[CmdletBinding()]
param(
    [ValidateRange(0, 65535)]
    [int]$Port = 3081
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$nodeExe = Join-Path $root "runtime\node\node.exe"
$dshEntry = Join-Path $root "runtime\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
$dshHome = Join-Path $root "dsh-home"
$dataDir = Join-Path $root "data"
$workbenchHome = Join-Path $dataDir "workbench"
$pidFile = Join-Path $dataDir "firmware-workbench.pid.json"

if (-not [Environment]::Is64BitOperatingSystem) {
    throw "This release requires 64-bit Windows."
}
if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) {
    throw "Bundled Node.js was not found: $nodeExe"
}
if (-not (Test-Path -LiteralPath $dshEntry -PathType Leaf)) {
    throw "Bundled DeepSeek Harness was not found: $dshEntry"
}
if (-not (Test-Path -LiteralPath (Join-Path $dshHome "profiles\web\node_modules\dsh-firmware-workbench\package.json") -PathType Leaf)) {
    throw "The dsh-firmware-workbench plugin was not found in the profile."
}

New-Item -ItemType Directory -Path $workbenchHome -Force | Out-Null

function Get-ValidatedWorkbenchProcess {
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) {
        return $null
    }
    try {
        $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
        $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)" -ErrorAction Stop
        if ($null -eq $candidate) {
            return $null
        }
        $sameExecutable = [System.StringComparer]::OrdinalIgnoreCase.Equals(
            [System.IO.Path]::GetFullPath($candidate.ExecutablePath),
            [System.IO.Path]::GetFullPath($nodeExe)
        )
        if ($sameExecutable -and $candidate.CommandLine.Contains($dshEntry)) {
            return $candidate
        }
    }
    catch {
        return $null
    }
    return $null
}

$existing = Get-ValidatedWorkbenchProcess
if ($null -ne $existing) {
    $existingRecord = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $existingUrl = "http://127.0.0.1:$($existingRecord.port)"
    Write-Host "打印机固件工作台已在运行: $existingUrl"
    Start-Process $existingUrl
    exit 0
}
if (Test-Path -LiteralPath $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force
}

$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodeExe
$startInfo.WorkingDirectory = $root
$startInfo.UseShellExecute = $false
$quotedEntry = '"' + $dshEntry + '"'
$startInfo.Arguments = "$quotedEntry web --host 127.0.0.1 --port $Port"
$startInfo.EnvironmentVariables["DSH_HOME"] = $dshHome
# 工作台 SQLite/证据目录:与 fwctl --db 指向同一份状态库
$startInfo.EnvironmentVariables["DSH_PRINTER_WORKBENCH_HOME"] = $workbenchHome

$process = [System.Diagnostics.Process]::Start($startInfo)
Start-Sleep -Seconds 3
if ($process.HasExited) {
    Write-Error "DSH host 已退出(exit $($process.ExitCode))。请检查 runtime 与 profile。"
    exit 1
}

@{ pid = $process.Id; port = $Port; startedAt = (Get-Date).ToString("o") } |
    ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8

$url = "http://127.0.0.1:$Port"
Write-Host ""
Write-Host "打印机固件工作台已启动: $url"
Write-Host "DSH profile: $dshHome\profiles\web"
Write-Host "工作台数据:  $workbenchHome\workbench.db"
Write-Host ""
Write-Host "提示: fwctl 与页面操作同一份状态库,例如:"
Write-Host ('  node firmware-workbench\lib\cli.js demo-verify --db "' + $workbenchHome + '\workbench.db"')
Write-Host ""
Start-Process $url
