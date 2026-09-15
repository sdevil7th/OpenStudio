param([ValidateSet('Debug', 'Release', 'ASan')] [string]$Configuration = 'Debug')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$binaryRoot = Join-Path $repoRoot "build/OpenStudio_artefacts/$Configuration"
$app = Join-Path $binaryRoot 'OpenStudio.exe'
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $app).Hash
$destination = Join-Path $repoRoot "output/symbols/$Configuration-$hash"
$files = @($app, (Join-Path $binaryRoot 'OpenStudio.pdb'),
    (Join-Path $binaryRoot 'OpenStudioCrashReporter.exe'),
    (Join-Path $repoRoot "build/$Configuration/OpenStudioCrashReporter.pdb"))
foreach ($file in $files) { if (-not (Test-Path -LiteralPath $file)) { throw "Missing matching build artifact: $file" } }
if (Test-Path -LiteralPath $destination) { throw "Archive already exists; it will not be overwritten: $destination" }
New-Item -ItemType Directory -Path $destination | Out-Null
$manifest = foreach ($file in $files) {
    Copy-Item -LiteralPath $file -Destination $destination
    @{ file = (Split-Path -Leaf $file); sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
}
@{ configuration = $Configuration; createdUtc = [DateTime]::UtcNow.ToString('o'); artifacts = $manifest } |
    ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $destination 'manifest.json')
Write-Host "Matching binaries and PDBs archived: $destination"
