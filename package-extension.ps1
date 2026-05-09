$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $projectRoot 'manifest.json'

if (-not (Test-Path $manifestPath)) {
    throw 'manifest.json non trovato nella root del progetto.'
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

if (-not $manifest.version) {
    throw 'La versione non e presente in manifest.json.'
}

$distPath = Join-Path $projectRoot 'dist'
$packageName = 'link-manager-v{0}.zip' -f $manifest.version
$packagePath = Join-Path $distPath $packageName

if (-not (Test-Path $distPath)) {
    New-Item -ItemType Directory -Path $distPath | Out-Null
}

if (Test-Path $packagePath) {
    Remove-Item $packagePath -Force
}

$itemsToPack = @(
    (Join-Path $projectRoot 'manifest.json')
    (Join-Path $projectRoot 'README.md')
    (Join-Path $projectRoot 'src')
)

$missingItems = $itemsToPack | Where-Object { -not (Test-Path $_) }
if ($missingItems) {
    throw ('Elementi mancanti per il pacchetto: {0}' -f ($missingItems -join ', '))
}

Compress-Archive -Path $itemsToPack -DestinationPath $packagePath -Force

Write-Host ('Pacchetto creato: {0}' -f $packagePath)