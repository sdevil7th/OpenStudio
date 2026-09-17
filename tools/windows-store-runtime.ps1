function Copy-StoreRuntimeDirectories {
    param(
        [Parameter(Mandatory = $true)][string]$SourceDir,
        [Parameter(Mandatory = $true)][string]$StageDir
    )

    $required = @('webui', 'effects', 'licenses', 'models', 'scripts')
    foreach ($directory in $required) {
        if (!(Test-Path -LiteralPath (Join-Path $SourceDir $directory) -PathType Container)) {
            throw "Missing runtime directory: $directory"
        }
    }
    foreach ($directory in $required) {
        Copy-Item -LiteralPath (Join-Path $SourceDir $directory) -Destination $StageDir -Recurse
    }

    # A clean CMake build has no bundled presets directory. Preserve one when
    # supplied, but do not require developer-created preset files for packaging.
    $presets = Join-Path $SourceDir 'presets'
    if (Test-Path -LiteralPath $presets) {
        if (!(Test-Path -LiteralPath $presets -PathType Container)) {
            throw 'Runtime presets path must be a directory.'
        }
        Copy-Item -LiteralPath $presets -Destination $StageDir -Recurse
    }
}
