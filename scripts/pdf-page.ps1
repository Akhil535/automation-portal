# Render one page of a PDF to a PNG with the PDF engine built into Windows (Windows.Data.Pdf) - nothing leaves the PC.
#   powershell -NoProfile -ExecutionPolicy Bypass -File pdf-page.ps1 <document.pdf> <out.png> [page (1-based)] [width px]
# Used to find a letterhead logo that is drawn as text / vector art (not a picture inside the PDF).
# Prints one JSON line: {"ok":true,"width":..,"height":..}
param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Out, [int]$Page = 1, [int]$Width = 2000)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
  function Await($op, [Type]$type) { $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  function AwaitAction($op) { $t = $asTaskAction.Invoke($null, @($op)); $t.Wait(-1) | Out-Null }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Path).Path)) ([Windows.Storage.StorageFile])
  $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $p = $pdf.GetPage([uint32]([Math]::Max(0, [Math]::Min($Page, [int]$pdf.PageCount) - 1)))
  $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
  $scale = $Width / [Math]::Max([double]$p.Size.Width, 1)
  $opts.DestinationWidth = [uint32]$Width
  $opts.DestinationHeight = [uint32]([Math]::Round([double]$p.Size.Height * $scale))
  $opts.BackgroundColor = [Windows.UI.Color]::FromArgb(255, 255, 255, 255)
  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  AwaitAction ($p.RenderToStreamAsync($stream, $opts))
  # the rendered stream is a PNG already: copy it out
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $size = [uint32]$stream.Size
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size
  $reader.ReadBytes($bytes)
  [System.IO.File]::WriteAllBytes($Out, $bytes)
  $reader.Dispose(); $stream.Dispose(); $p.Dispose()
  '{"ok":true,"width":' + $opts.DestinationWidth + ',"height":' + $opts.DestinationHeight + '}'
} catch { '{"ok":false,"reason":' + ($_.Exception.Message | ConvertTo-Json) + '}' }
