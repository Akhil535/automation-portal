# Layout check of finished PDF files (local, nothing is sent out): page 1 is rendered and the logo at the top is
# measured - the first block of ink from the top of the page (page borders ignored). Reports how far its centre is
# from the centre of the page, its top margin and its size, in millimetres.
# Usage: layout-check.ps1 <list.json>   (list = ["C:\\...\\a.pdf", ...]); prints one JSON line with the results.
param([Parameter(Mandatory = $true)][string]$List)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$asAction = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class LayoutScan {
  // returns [minX, maxX, minY, maxY] of the first block of ink from the top, or null
  public static int[] TopBlock(Bitmap b) {
    int w = b.Width, h = b.Height;
    var d = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    byte[] px = new byte[d.Stride * h]; Marshal.Copy(d.Scan0, px, 0, px.Length); b.UnlockBits(d);
    int x0 = (int)(w * 0.08), x1 = (int)(w * 0.92);   // page borders sit outside this band
    int minX = int.MaxValue, maxX = -1, minY = -1, maxY = -1, blank = 0;
    for (int y = (int)(h * 0.01); y < h * 0.35; y++) {
      int count = 0, rx0 = int.MaxValue, rx1 = -1;
      for (int x = x0; x < x1; x++) {
        int i = y * d.Stride + x * 4;
        int a = px[i + 3]; int lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
        if (a > 0 && lum < 225) { count++; if (x < rx0) rx0 = x; rx1 = x; }
      }
      bool border = count > (x1 - x0) * 0.8;          // a horizontal page-border line
      if (count > 0 && !border) {
        if (minY < 0) minY = y;
        maxY = y; blank = 0;
        if (rx0 < minX) minX = rx0; if (rx1 > maxX) maxX = rx1;
      } else if (minY >= 0 && ++blank > 6) break;      // the logo block ends at the first clear gap
    }
    return minY < 0 ? null : new int[] { minX, maxX, minY, maxY };
  }
}
'@

$out = @()
foreach ($pdf in (Get-Content -Raw -Encoding UTF8 $List | ConvertFrom-Json)) {
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdf)) ([Windows.Storage.StorageFile])
    $doc = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    $page = $doc.GetPage(0)
    $mmW = $page.Size.Width / 96 * 25.4   # PdfPage.Size is in device-independent pixels (1/96 inch)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $o = New-Object Windows.Data.Pdf.PdfPageRenderOptions; $o.DestinationWidth = 1000
    $asAction.Invoke($null, @($page.RenderToStreamAsync($stream, $o))).Wait()
    $bmp = New-Object System.Drawing.Bitmap ([System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0)))
    $k = $mmW / $bmp.Width
    $r = [LayoutScan]::TopBlock($bmp)
    if ($r) {
      $centre = (($r[0] + $r[1]) / 2 - $bmp.Width / 2) * $k
      $out += [pscustomobject]@{ pdf = $pdf; found = $true; offsetMm = [math]::Round($centre, 1); topMm = [math]::Round($r[2] * $k, 1); widthMm = [math]::Round(($r[1] - $r[0]) * $k, 1); heightMm = [math]::Round(($r[3] - $r[2]) * $k, 1); pages = $doc.PageCount }
    } else { $out += [pscustomobject]@{ pdf = $pdf; found = $false; pages = $doc.PageCount } }
    $bmp.Dispose()
  } catch { $out += [pscustomobject]@{ pdf = $pdf; found = $false; error = $_.Exception.Message } }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 4
