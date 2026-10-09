# Bouwt het complete htm-bestand voor de eigen website
# (hsvderuisvoorn.nl) uit website/site-fragment.html, style.css en
# website/site.js. Eén bestand, niets externe behalve de fonts en het
# logo van de site zelf.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\bouw-websitebestand.ps1
#
# Levert op:
#   website\autovergunning.html   het te plaatsen bestand
param()
$ErrorActionPreference = "Stop"

$repo     = Split-Path -Parent $PSScriptRoot
$website  = Join-Path $repo "website"
$fragment = Join-Path $website "site-fragment.html"
$jsBron   = Join-Path $website "site.js"
$cssBron  = Join-Path $repo "style.css"
$uit      = Join-Path $website "autovergunning.html"

foreach ($pad in @($fragment, $jsBron, $cssBron)) {
  if (-not (Test-Path -LiteralPath $pad)) { throw "bron ontbreekt: $pad" }
}

$css = Get-Content -LiteralPath $cssBron -Raw
$css = [regex]::Replace($css, "(?s)/\*.*?\*/", "").Trim()

$js = Get-Content -LiteralPath $jsBron -Raw
$body = (Get-Content -LiteralPath $fragment -Raw).Trim()

$hoofd = @'
<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Aanvraag Autovergunning | HSV De Ruisvoorn</title>
<meta name="description" content="Vraag een Autovergunning of een duplicaat daarvan aan bij HSV De Ruisvoorn Helden. Bij een eerste aanvraag is een invalidenkaart minimaal verplicht.">
<link rel="icon" href="https://hsvderuisvoorn.nl/favicon.ico">
<meta name="theme-color" content="#124f76">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700;900&display=swap" rel="stylesheet">
<style>
CSS_HIER
</style>
</head>
<body>
BODY_HIER

<script>
JS_HIER
</script>
</body>
</html>
'@

$uitvoer = $hoofd.Replace("CSS_HIER", $css).Replace("BODY_HIER", $body).Replace("JS_HIER", $js)
[System.IO.File]::WriteAllText($uit, $uitvoer, (New-Object System.Text.UTF8Encoding($false)))

$f = Get-Item -LiteralPath $uit
"gebouwd: website\autovergunning.html $($f.Length) bytes"
