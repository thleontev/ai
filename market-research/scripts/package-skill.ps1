param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$projectRoot = Split-Path -Parent $PSScriptRoot
$skillPath = Join-Path $projectRoot '.opencode\skills\product-research'
$md2pdfPath = Join-Path $projectRoot '.opencode\skills\md2pdf'
$outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $outputFullPath
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("product-research-package-" + [Guid]::NewGuid())

if (-not (Test-Path -LiteralPath $skillPath)) { throw "Не найден skill: $skillPath" }
if (-not (Test-Path -LiteralPath $md2pdfPath)) { throw "Не найден skill: $md2pdfPath" }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $stage -Force | Out-Null

try {
  $packageRoot = Join-Path $stage 'product-research'
  New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
  Copy-Item -LiteralPath $skillPath -Destination (Join-Path $packageRoot '.opencode\skills\product-research') -Recurse
  Copy-Item -LiteralPath $md2pdfPath -Destination (Join-Path $packageRoot '.opencode\skills\md2pdf') -Recurse
  Copy-Item -LiteralPath (Join-Path $projectRoot 'README.md') -Destination $packageRoot
  Copy-Item -LiteralPath (Join-Path $projectRoot 'PROJECT_STRUCTURE.md') -Destination $packageRoot
  Compress-Archive -LiteralPath $packageRoot -DestinationPath $outputFullPath -Force
}
finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}

Write-Output "Создан чистый пакет: $outputFullPath"
