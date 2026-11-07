# Convert Word documents to print-ready PDF with Microsoft Word on this PC (macros disabled, documents opened
# read-only). Input: a JSON file with [{ "in": "...docx", "out": "...pdf" }, ...]. Output: one JSON line with results.
param([string]$List)
$ErrorActionPreference = 'Stop'
$jobs = Get-Content -Raw -LiteralPath $List | ConvertFrom-Json
$results = @()
$word = $null
try {
  $word = New-Object -ComObject Word.Application
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
  if ($word) { $word.Quit() | Out-Null; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null }
}
ConvertTo-Json -InputObject @($results) -Compress -Depth 3
