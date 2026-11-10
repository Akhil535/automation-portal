# Convert Word documents to print-ready PDF with Microsoft Word on this PC (macros disabled, documents opened
# read-only). Input: a JSON file with [{ "in": "...docx", "out": "...pdf" }, ...]. Output: one JSON line with results.
# Word (Microsoft 365) may hand out ONE shared copy: a Word that was already running (the user's own, or another
# conversion's) is never closed here - only a Word this run started itself. If Word goes away in the middle of the
# run, it is started again and the document is tried once more (the rest of the list is not lost).
param([string]$List)
$ErrorActionPreference = 'Stop'
$jobs = Get-Content -Raw -LiteralPath $List | ConvertFrom-Json
$results = @()
$script:word = $null
$script:mine = @()

function Start-Word {
  $before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  $w = New-Object -ComObject Word.Application
  # the Word process this run started (only when exactly one new Word appeared – never someone else's Word)
  $new = @()
  for ($i = 0; $i -lt 20 -and -not $new.Count; $i++) {
    $new = @(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
    if (-not $new.Count) { Start-Sleep -Milliseconds 100 }
  }
  $script:mine = if ($new.Count -eq 1) { $new } else { @() }
  if ($script:mine.Count) { $w.Visible = $false }   # a shared Word that was already open keeps its window as it was
  $w.DisplayAlerts = 0
  $w.AutomationSecurity = 3   # msoAutomationSecurityForceDisable
  $script:word = $w
}
function Stop-Word {
  $w = $script:word
  if ($w) {
    # Quit only a Word this run started; a shared one is just let go (its own documents stay open)
    if ($script:mine.Count) { try { $w.Quit() | Out-Null } catch {} }
    try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null } catch {}
  }
  $script:word = $null; [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  foreach ($id in $script:mine) {
    for ($i = 0; $i -lt 20 -and (Get-Process -Id $id -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 150 }
    Get-Process -Id $id -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  $script:mine = @()
}
function Convert-One($j) {
  $doc = $script:word.Documents.Open($j.in, $false, $true, $false)
  try {
    $doc.Fields.Update() | Out-Null
    # 17 = wdExportFormatPDF; optimise for print; include document structure tags / bookmarks
    $doc.ExportAsFixedFormat($j.out, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)
  } finally { try { $doc.Close($false) } catch {} }
}
# Word itself went away (closed, crashed, disconnected) – as opposed to a problem with one document
$gone = 'RPC server|0x800706BA|0x800706BE|0x80010108|disconnected|null-valued|not connected|CO_E_|server threw an exception'

try {
  Start-Word
  foreach ($j in @($jobs)) {
    $err = $null
    for ($try = 1; $try -le 2; $try++) {
      try {
        if (-not $script:word) { Start-Word }
        Convert-One $j
        $err = $null; break
      } catch {
        $err = $_.Exception.Message
        if ($err -match $gone -and $try -lt 2) { Stop-Word; Start-Sleep -Milliseconds 800; continue } # restart Word, try again
        break
      }
    }
    if ($err) { $results += [pscustomobject]@{ in = $j.in; out = $j.out; ok = $false; error = $err } }
    else { $results += [pscustomobject]@{ in = $j.in; out = $j.out; ok = (Test-Path -LiteralPath $j.out) } }
  }
} catch {
  $results = @([pscustomobject]@{ ok = $false; error = "Microsoft Word could not be started: $($_.Exception.Message)" })
} finally {
  Stop-Word
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 3
