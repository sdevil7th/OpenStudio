param([ValidateSet('Debug', 'Release', 'ASan')] [string]$Configuration = 'Debug',
      [string]$BuildDirectory = 'build')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$app = Join-Path $BuildDirectory "OpenStudio_artefacts/$Configuration/OpenStudio.exe"
& python (Join-Path $PSScriptRoot 'build-symbols.py') archive --app $app --build-dir $BuildDirectory --output (Join-Path $repoRoot 'output/symbols')
if ($LASTEXITCODE -ne 0) { throw 'Matching symbol archive failed; no archive was published.' }
