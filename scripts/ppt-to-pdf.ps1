# Convert PowerPoint presentations to PDF with Microsoft PowerPoint on this PC (opened read-only, no window).
# Input: a JSON file with [{ "in": "...pptx", "out": "...pdf" }, ...]. Output: one JSON line with the results.
# The PowerPoint process this run started is always closed at the end (also when Quit does not end it).
param([string]$List)
$ErrorActionPreference = 'Stop'
$jobs = Get-Content -Raw -LiteralPath $List | ConvertFrom-Json
$results = @()
$app = $null
$before = @(Get-Process POWERPNT -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$mine = @()
try {
  $app = New-Object -ComObject PowerPoint.Application
  for ($i = 0; $i -lt 20 -and -not $mine.Count; $i++) {
    $mine = @(Get-Process POWERPNT -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
    if (-not $mine.Count) { Start-Sleep -Milliseconds 100 }
  }
  if ($mine.Count -ne 1) { $mine = @() }
  foreach ($j in @($jobs)) {
    try {
      # Open(FileName, ReadOnly, Untitled, WithWindow)
      $pres = $app.Presentations.Open($j.in, -1, 0, 0)
      try { $pres.SaveAs($j.out, 32) } finally { $pres.Close() }   # 32 = ppSaveAsPDF
      $results += [pscustomobject]@{ in = $j.in; out = $j.out; ok = (Test-Path -LiteralPath $j.out) }
    } catch {
      $results += [pscustomobject]@{ in = $j.in; out = $j.out; ok = $false; error = $_.Exception.Message }
    }
  }
} catch {
  $results = @([pscustomobject]@{ ok = $false; error = "Microsoft PowerPoint could not be started: $($_.Exception.Message)" })
} finally {
  if ($app) { try { $app.Quit() | Out-Null } catch {}; try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null } catch {} }
  $app = $null; [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  foreach ($id in $mine) {
    for ($i = 0; $i -lt 20 -and (Get-Process -Id $id -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 150 }
    Get-Process -Id $id -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 3
