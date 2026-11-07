# Offline OCR with the engines built into Windows (Windows.Data.Pdf + Windows.Media.Ocr). Nothing leaves the PC.
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 <image.png | document.pdf> [language-tag] [max-pages]
# Images are read directly; PDF pages are rendered as whole pages (so text inside pictures, logos and stamps is
# read too) at ~2x size for accuracy. Prints one recognised text line per line.
param([Parameter(Mandatory = $true)][string]$Path, [string]$Language = 'en-US', [int]$MaxPages = 3)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]

$asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, [Type]$type) { $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function AwaitAction($op) { $t = $asTaskAction.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }

$lang = New-Object Windows.Globalization.Language $Language
$engine = if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) { [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang) } else { [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'No OCR language is installed in Windows' }

function Read-Stream($stream) {
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  foreach ($line in $result.Lines) { $line.Text }
}

$full = (Resolve-Path $Path).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
if ($full -match '\.pdf$') {
  $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $n = [Math]::Min([int]$pdf.PageCount, $MaxPages)
  for ($i = 0; $i -lt $n; $i++) {
    $page = $pdf.GetPage([uint32]$i)
    $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $w = [double]$page.Size.Width
    $scale = [Math]::Min(2.5, [Math]::Max(1.0, 2000.0 / [Math]::Max($w, 1)))   # ~2000 px wide (OCR limit is 10000)
    $opts.DestinationWidth = [uint32]([Math]::Round($w * $scale))
    $opts.DestinationHeight = [uint32]([Math]::Round([double]$page.Size.Height * $scale))
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    AwaitAction ($page.RenderToStreamAsync($stream, $opts))
    Read-Stream $stream
    $stream.Dispose(); $page.Dispose()
  }
} else {
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  Read-Stream $stream
  $stream.Dispose()
}
