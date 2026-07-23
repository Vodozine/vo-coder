# Turns a (roughly square) mascot image into every icon size the app needs.
# Usage:  powershell -File scripts\icons-from-image.ps1 -Source "C:\path\to\mascot.png"
# Output: apps\desktop\build\icon-<size>.png (16..256) + icon.png (512)
#         assets\vodo-mascot.png (512)
# Then run:  node scripts\pack-ico.mjs   (packs the PNGs into build\icon.ico)
param([Parameter(Mandatory = $true)][string]$Source)

Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root "apps\desktop\build"
$assetsDir = Join-Path $root "assets"
New-Item -ItemType Directory -Force -Path $buildDir, $assetsDir | Out-Null

$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source))
# Center-crop to square.
$side = [Math]::Min($src.Width, $src.Height)
$cropX = [int](($src.Width - $side) / 2)
$cropY = [int](($src.Height - $side) / 2)

function Save-Resized([int]$size, [string]$path) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $dest = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $srcRect = New-Object System.Drawing.Rectangle($cropX, $cropY, $side, $side)
  $g.DrawImage($src, $dest, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "wrote $path"
}

foreach ($s in 16, 24, 32, 48, 64, 128, 256) {
  Save-Resized $s (Join-Path $buildDir "icon-$s.png")
}
Save-Resized 512 (Join-Path $buildDir "icon.png")
Save-Resized 512 (Join-Path $assetsDir "vodo-mascot.png")
$src.Dispose()
Write-Host "now run: node scripts/pack-ico.mjs"
