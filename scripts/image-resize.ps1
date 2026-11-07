# Plain high-quality resize of a picture to at most -Max pixels on its longest side, saved as PNG (keeps transparency).
# Used when the crop / background clean-up cannot run, so a huge picture never ends up inside every policy.
# -Jpeg: white background, JPEG quality 88 - far smaller for photo-like logos (a printed page is white anyway).
param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$Out, [int]$Max = 1000, [switch]$Jpeg)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $src = [System.Drawing.Image]::FromFile($In)
  try {
    $scale = [Math]::Min(1.0, $Max / [Math]::Max($src.Width, $src.Height))
    $w = [Math]::Max(1, [int][Math]::Round($src.Width * $scale)); $h = [Math]::Max(1, [int][Math]::Round($src.Height * $scale))
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    if ($Jpeg) { $g.Clear([System.Drawing.Color]::White) } else { $g.Clear([System.Drawing.Color]::Transparent) }
    $g.DrawImage($src, 0, 0, $w, $h)
    $g.Dispose()
  } finally { $src.Dispose() }
  if ($Jpeg) {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
    $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]88)
    $bmp.Save($Out, $codec, $ep)
  } else { $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png) }
  $bmp.Dispose()
  @{ ok = $true; width = $w; height = $h } | ConvertTo-Json -Compress
} catch { @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress }
