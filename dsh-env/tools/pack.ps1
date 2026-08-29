[CmdletBinding()]
param(
    [string]$Version = "0.1.0",
    [string]$OutDir = "D:\roon\workflow_2\firmware-workbench\release"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$packageName = "printer-firmware-workbench-portable-win-x64-$Version"
$stageRoot = Join-Path $root ".pack-stage"
$stage = Join-Path $stageRoot $packageName
$zipPath = Join-Path $OutDir "$packageName.zip"

if (-not (Test-Path (Join-Path $root "runtime\node\node.exe") -PathType Leaf)) {
    throw "runtime/node/node.exe missing; assemble dsh-env first."
}
if (-not (Test-Path (Join-Path $root "dsh-home\profiles\web\node_modules\dsh-firmware-workbench\package.json") -PathType Leaf)) {
    throw "profile plugin missing; run pnpm install in the profile first."
}

if (Test-Path $stageRoot) {
    Remove-Item $stageRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# runtime + profile + packages + tools + docs,排除运行期数据
$copyDirs = @("runtime", "dsh-home", "packages", "tools")
foreach ($dir in $copyDirs) {
    Copy-Item (Join-Path $root $dir) (Join-Path $stage $dir) -Recurse -Force
}
foreach ($cmd in @("启动工作台.cmd", "停止工作台.cmd")) {
    Copy-Item (Join-Path $root $cmd) (Join-Path $stage $cmd) -Force
}
$docsSrc = "D:\roon\workflow_2\firmware-workbench\docs"
if (Test-Path $docsSrc) {
    Copy-Item $docsSrc (Join-Path $stage "docs") -Recurse -Force
}
$spikeReport = "D:\roon\workflow_2\firmware-workbench\spike\dagu\dagu-spike-report.md"
if (Test-Path $spikeReport) {
    New-Item -ItemType Directory -Path (Join-Path $stage "docs") -Force | Out-Null
    Copy-Item $spikeReport (Join-Path $stage "docs\dagu-spike-report.md") -Force
}
$solution = "D:\roon\workflow_2\printer-firmware-workbench-solution-v1.0.md"
if (Test-Path $solution) {
    Copy-Item $solution (Join-Path $stage "docs\printer-firmware-workbench-solution-v1.0.md") -Force
}

@{
    node = "Node.js v24.19.0 (MIT)"
    dsh = "@deepseek-ai/dsh 0.1.1-rc.2 and its dependency tree (MIT, see runtime/dsh/node_modules/*/LICENSE)"
    plugin = "dsh-firmware-workbench 0.1.0 (MIT)"
    dagu_spike = "Dagu v2.15.4 was used for a time-boxed Runner spike; binaries are not bundled (GPL-3.0)"
    third_party = "Full licenses live next to each package under runtime/dsh/node_modules."
} | ConvertTo-Json | Set-Content (Join-Path $stage "THIRD_PARTY_NOTICES.json") -Encoding UTF8

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipPath -Force
Remove-Item $stageRoot -Recurse -Force

$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $zipPath -Leaf)" | Set-Content (Join-Path $OutDir "SHA256SUMS.txt") -Encoding ASCII
Write-Host "portable package: $zipPath"
Write-Host "sha256: $hash"
