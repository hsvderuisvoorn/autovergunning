# Bouwt het zelfstandige invoegblok voor de eigen website
# (stijl + opmaak + script) uit aanvraag.html, style.css en aanvraag.js.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\bouw-invoegcode.ps1
#
# Levert op:
#   ..\autovergunning-invoegcode.html   werkbestand (niet in git)
#   invoegcode.txt                      de te plakken code (wel in git)
param()
$ErrorActionPreference = "Stop"

$repo  = Split-Path -Parent $PSScriptRoot
$src   = $repo
$out   = Join-Path (Split-Path -Parent $repo) "autovergunning-invoegcode.html"
$kopie = Join-Path $repo "invoegcode.txt"
$p     = ".av-root"

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

# --- CSS ---
$css = Get-Content -LiteralPath "$src\style.css" -Raw
$css = [regex]::Replace($css, "(?s)/\*.*?\*/", "")
$css = Convert-Styles $css
$css = $css.Trim()

# --- HTML: body-inhoud ---
$html = Get-Content -LiteralPath "$src\aanvraag.html" -Raw
$b = $html.IndexOf("<body>") + "<body>".Length
$e = $html.LastIndexOf("</body>")
$body = $html.Substring($b, $e - $b).Trim()
$body = [regex]::Replace($body, '\s*<link rel="stylesheet" href="\./style\.css\?v=dev">', "")
$body = [regex]::Replace($body, '\s*<script src="\./aanvraag\.js\?v=dev" defer></script>', "")
$body = $body.Replace("./logo.png", "https://hsvderuisvoorn.github.io/autovergunning/logo.png")
$cls = $p.TrimStart(".")
$body = "<div class=`"$cls`">`n" + $body + "`n</div>"

# --- JS: init ook als het blok later dan DOMContentLoaded wordt uitgevoerd ---
$js = Get-Content -LiteralPath "$src\aanvraag.js" -Raw
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
if (-not $js.Contains($oud)) { throw "init-regel niet gevonden in aanvraag.js" }
$js = $js.Replace($oud, $nieuw.TrimEnd())

$blok = @"
<!-- ============================================================
     AUTOVERGUNNING - invoegblok voor de eigen website
     Plak dit geheel in het Content-veld van de pagina.
     Bron: aanvraag.html + style.css + aanvraag.js (repository
     hsvderuisvoorn/autovergunning). Styling zit onder .av-root,
     zodat de eigen sitestijl buiten het blok onaangetast blijft.
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

Set-Content -LiteralPath $out -Value $blok -Encoding UTF8 -NoNewline
Copy-Item -LiteralPath $out -Destination $kopie -Force
$f = Get-Item -LiteralPath $out
"gebouwd: $($f.Name) $($f.Length) bytes (naar invoegcode.txt gekopieerd)"
