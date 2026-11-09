# Convert Word documents to print-ready PDF with Microsoft Word on this PC (macros disabled, documents opened
# read-only). Input: a JSON file with [{ "in": "...docx", "out": "...pdf" }, ...]. Output: one JSON line with results.
param([string]$List)
$ErrorActionPreference = 'Stop'
$jobs = Get-Content -Raw -LiteralPath $List | ConvertFrom-Json
$results = @()
$word = $null
$before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$mine = @()
try {
  $word = New-Object -ComObject Word.Application
  # the Word process this conversion started (closed for sure at the end, even if Quit does not end it)
  # (only when exactly one new Word appeared while this one started – never another conversion's Word)
  for ($i = 0; $i -lt 20 -and -not $mine.Count; $i++) {
    $mine = @(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
    if (-not $mine.Count) { Start-Sleep -Milliseconds 100 }
  }
  if ($mine.Count -ne 1) { $mine = @() }
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3   # msoAutomationSecurityForceDisable
  foreach ($j in @($jobs)) {
    try {
      $doc = $word.Documents.Open($j.in, $false, $true, $false)
      try {
        $doc.Fields.Update() | Out-Null
        # 17 = wdExportFormatPDF; optimise for print; include document structure tags / bookmarks
        $doc.ExportAsFixedFormat($j.out, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)
      } finally { $doc.Close($false) }
      $results += [pscustomobject]@{ in = $j.in; out = $j.out; ok = (Test-Path -LiteralPath $j.out) }
    } catch {
      $results += [pscustomobject]@{ in = $j.in; out = $j.out; ok = $false; error = $_.Exception.Message }
    }
  }
} catch {
  $results = @([pscustomobject]@{ ok = $false; error = "Microsoft Word could not be started: $($_.Exception.Message)" })
} finally {
  if ($word) { try { $word.Quit() | Out-Null } catch {}; try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch {} }
  $word = $null; [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  # give Word a moment to end by itself, then make sure it is gone
  foreach ($id in $mine) {
    for ($i = 0; $i -lt 20 -and (Get-Process -Id $id -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 150 }
    Get-Process -Id $id -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 3
