# Bouwt het zelfstandige invoegblok voor de eigen website
# (hsvderuisvoorn.nl) uit website/site-fragment.html, style.css en
# website/site.js. Alle stijlregels worden onder .av-root gezet, zodat
# de sitestijl van de clubsite buiten het blok onaangetast blijft.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\bouw-website-invoegcode.ps1
#
# Levert op:
#   website\invoegcode.txt   de te plakken code
param()
$ErrorActionPreference = "Stop"

$repo     = Split-Path -Parent $PSScriptRoot
$website  = Join-Path $repo "website"
$fragment = Join-Path $website "site-fragment.html"
$jsBron   = Join-Path $website "site.js"
$cssBron  = Join-Path $repo "style.css"
$uit      = Join-Path $website "invoegcode.txt"
$p        = ".av-root"

foreach ($pad in @($fragment, $jsBron, $cssBron)) {
  if (-not (Test-Path -LiteralPath $pad)) { throw "bron ontbreekt: $pad" }
}

function Prefix-Selector([string]$sel) {
  $s = $sel.Trim()
  if ($s -eq "") { return $s }
  if ($s -eq ":root") { return $p }
  if ($s -eq "*") { return "$p, $p *" }
  if ($s -eq "html" -or $s -eq "body") { return $p }
  if ($s.StartsWith("html ") -or $s.StartsWith("body ")) {
    return $p + $s.Substring($s.IndexOf(" "))
  }
  return "$p $s"
}

function Convert-Styles([string]$text) {
  $res = ""
  $i = 0
  while ($i -lt $text.Length) {
    $open = $text.IndexOf("{", $i)
    if ($open -lt 0) { $res += $text.Substring($i); break }
    $header = $text.Substring($i, $open - $i).Trim()
    $depth = 1
    $j = $open + 1
    while ($j -lt $text.Length -and $depth -gt 0) {
      $c = $text[$j]
      if ($c -eq "{") { $depth++ } elseif ($c -eq "}") { $depth-- }
      $j++
    }
    $inner = $text.Substring($open + 1, $j - $open - 2)
    if ($header -like "@keyframes*") {
      $res += $header + "{" + $inner + "}`n"
    } elseif ($header -like "@media*" -or $header -like "@supports*") {
      $res += $header + "{`n" + (Convert-Styles $inner) + "`n}`n"
    } else {
      $sels = @()
      foreach ($s in ($header -split ",")) { $sels += (Prefix-Selector $s) }
      $res += ($sels -join ", ") + " {" + $inner + "}`n"
    }
    $i = $j
  }
  return $res
}

# --- CSS: commentaren eruit, alle selectors onder .av-root ---
$css = [System.IO.File]::ReadAllText($cssBron, (New-Object System.Text.UTF8Encoding($false)))
$css = [regex]::Replace($css, "(?s)/\*.*?\*/", "")
$css = Convert-Styles $css
$css = $css.Trim()

# --- HTML: body-inhoud van het fragment ---
$body = [System.IO.File]::ReadAllText($fragment, (New-Object System.Text.UTF8Encoding($false))).Trim()
# De golfband onder de kop en een eventuele voettekst horen bij de
# losse pagina; op de eigen website staan die al rondom de pagina.
$body = [regex]::Replace($body, '(?s)\s*<div class="golf-band".*?</svg>\s*</div>', "")
if ($body -match 'golf-band') { throw "golfband uit het invoegblok verwijderen is mislukt" }
$cls  = $p.TrimStart(".")
$body = "<div class=`"$cls`">`n" + $body + "`n</div>"

# --- JS: init ook als het blok later dan DOMContentLoaded wordt ingevoegd ---
$js = [System.IO.File]::ReadAllText($jsBron, (New-Object System.Text.UTF8Encoding($false)))
$oud = 'document.addEventListener("DOMContentLoaded", koppelKlaarzetten);'
$nieuw = @'
(function avInit() {
  function start() {
    if (window.__avGekoppeld) { return; }
    window.__avGekoppeld = true;
    koppelKlaarzetten();
  }
  if (window.__avGekoppeld) { return; }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
'@
if (-not $js.Contains($oud)) { throw "init-regel niet gevonden in website/site.js" }
$js = $js.Replace($oud, $nieuw.TrimEnd())

$blok = @"
<!-- ============================================================
     AUTOVERGUNNING - invoegblok voor de eigen website
     Plak dit geheel in het Content-veld van de pagina.
     Bron: website/site-fragment.html + style.css + website/site.js
     (repository hsvderuisvoorn/autovergunning). De styling staat
     onder .av-root, zodat de eigen sitestijl buiten het blok
     onaangetast blijft.
     ============================================================ -->
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700;900&display=swap" rel="stylesheet">
<style>
$css
</style>

$body

<script>
$js
</script>
"@

$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($uit, $blok, $enc)
$f = Get-Item -LiteralPath $uit
"gebouwd: website\invoegcode.txt $($f.Length) bytes"
