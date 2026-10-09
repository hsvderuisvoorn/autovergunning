/* =============================================================
   Autovergunning — websitebestand (hsvderuisvoorn.nl)
   Frontend voor het invoegblok in een bestaande pagina.

   Werkt met de backend die al voor de oude aanvraagpagina draait
   (backend/AUTOVERGUNNING-KOPIEER-DIT.js, al geïmplementeerd op
   Apps Script): er hoeft niets geïnstalleerd of gedeployd te worden.
   Alles gaat via JSONP: een POST vanuit een browser wordt door de
   redirect van Apps Script in een GET veranderd, waardoor doPost
   nooit zou draaien.

   De backend spreekt: ?act=aanvraag&data=...&callback=...
                        ?act=bekend&ref=...        (antwoord: gevonden)
                        ?act=betaallink&ref=...&nieuw=0|1 (antwoord: url)
                        ?act=status&ref=...        (antwoord: status)
   ============================================================= */

var BACKEND_URL = "https://script.google.com/macros/s/AKfycbyGgzq52fmObOgDZndUQSKssPCwzFZz7wAiAmSSFZrauo2n9E7UZmK4naoUS6eZFIY/exec";

var VERZEND_TIMEOUT_MS = 45000;
var VERZEND_POGINGEN = 3;
var REF_SLEUTEL = "hsvDuplicaatRef";

var laatsteSoortAanvraag = "";
var laatsteRef = "";
var laatsteMollieUrl = "";

/* ------------------------------------------------------------
   Backend aanroepen (JSONP)
   ------------------------------------------------------------ */
function backendJsonp(act, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    if (!BACKEND_URL) { reject(new Error("backend niet ingesteld")); return; }
    var cb = "hsvCb" + Date.now() + Math.floor(Math.random() * 1000);
    var script = document.createElement("script");
    var timer = setTimeout(function () {
      ruim(cb, script);
      reject(new Error("timeout"));
    }, timeoutMs || VERZEND_TIMEOUT_MS);
    function ruim(naam, el) {
      clearTimeout(timer);
      try { delete window[naam]; } catch (e) { window[naam] = undefined; }
      if (el && el.parentNode) { el.parentNode.removeChild(el); }
    }
    window[cb] = function (data) {
      ruim(cb, script);
      resolve(data || {});
    };
    script.onerror = function () {
      ruim(cb, script);
      reject(new Error("netwerk"));
    };
    script.src = BACKEND_URL + "?act=" + act + "&callback=" + cb +
      "&" + (params || "");
    document.head.appendChild(script);
  });
}

/* ------------------------------------------------------------
   Referentie onthouden (nodig na terugkomst van Mollie)
   ------------------------------------------------------------ */
function bewaarRef(ref) {
  laatsteRef = ref || laatsteRef;
  if (!laatsteRef) { return; }
  try { sessionStorage.setItem(REF_SLEUTEL, laatsteRef); } catch (e) { /* geen opslag */ }
  try {
    document.cookie = REF_SLEUTEL + "=" + encodeURIComponent(laatsteRef) +
      "; path=/; max-age=1800; SameSite=Lax";
  } catch (e) { /* geen cookies */ }
}

function haalRefOp() {
  var ref = "";
  try { ref = sessionStorage.getItem(REF_SLEUTEL) || ""; } catch (e) { ref = ""; }
  if (!ref) {
    var naam = REF_SLEUTEL + "=";
    var delen = String(document.cookie || "").split(";");
    for (var i = 0; i < delen.length; i++) {
      var stuk = delen[i].replace(/^\s+/, "");
      if (stuk.indexOf(naam) === 0) { ref = decodeURIComponent(stuk.substring(naam.length)); }
    }
    if (ref) { bewaarRef(ref); }
  }
  return ref;
}

/* ------------------------------------------------------------
   Meldingen
   ------------------------------------------------------------ */
function toonStatus(tekst, soort) {
  var el = document.getElementById("statusTekst");
  if (!el) { return; }
  el.textContent = tekst;
  el.className = "zichtbaar";
  if (soort === "ok")   { el.classList.add("ok"); }
  if (soort === "fout") { el.classList.add("fout"); }
  if (soort === "info") { el.classList.add("info"); }
}

function toonAls(el, zichtbaar) {
  if (el) { el.hidden = !zichtbaar; }
}

function toonMollieStatus(bericht) {
  var el = document.getElementById("mollieStatus");
  if (!el) { return; }
  el.textContent = bericht || "";
  el.hidden = !bericht;
}

/* ------------------------------------------------------------
   Betaallink tonen / nieuwe link vragen
   ------------------------------------------------------------ */
function zetMollieKnop(url, melding) {
  var blok = document.getElementById("mollieBlok");
  var knop = document.getElementById("mollieKnop");
  var tekst = document.getElementById("mollieUrlTekst");
  if (!url) {
    if (blok) { blok.hidden = true; blok.style.display = "none"; }
    toonMollieStatus("");
    return;
  }
  laatsteMollieUrl = url;
  if (blok) { blok.hidden = false; blok.style.display = "block"; }
  if (knop) {
    knop.href = url;
    knop.classList.remove("niet-klaar");
    knop.removeAttribute("aria-disabled");
  }
  if (tekst) { tekst.textContent = url; }
  toonMollieStatus(melding || "");
}

function vraagBetaallinkOp(nieuw) {
  var ref = laatsteRef || haalRefOp();
  if (!ref) { return Promise.resolve(); }
  toonMollieStatus(nieuw ? "Een nieuwe betaallink wordt aangemaakt..." : "Betaallink ophalen...");
  return backendJsonp("betaallink",
    "ref=" + encodeURIComponent(ref) + "&nieuw=" + (nieuw ? "1" : "0"), 30000)
    .then(function (data) {
      var link = data ? (data.betaallink || data.url) : "";
      if (link) {
        zetMollieKnop(link, nieuw ? "Nieuwe betaallink aangemaakt." : "");
        return;
      }
      toonMollieStatus("De betaallink kon niet worden opgehaald. " +
        String((data && data.fout) || "Probeer het later opnieuw.") +
        " U kunt ook mailen naar secretariaat@hsvderuisvoorn.nl.");
    })
    .catch(function () {
      toonMollieStatus("Geen verbinding om de betaallink op te halen. Probeer het over enkele seconden opnieuw.");
    });
}

/* ------------------------------------------------------------
   Terug van Mollie: status controleren
   ------------------------------------------------------------ */
var TERUG_POGINGEN = 6;
var TERUG_INTERVAL = 2500;

function controleerBetaalstatus() {
  var sectie = document.getElementById("terugVanBetaling");
  var tekst = document.getElementById("terugTekst");
  var titel = document.getElementById("terugTitel");
  var icoon = document.getElementById("terugIcoon");
  var knop = document.getElementById("terugStatusKnop");
  var knopSite = document.getElementById("terugNaarSite");
  var ref = haalRefOp();
  if (!sectie || !ref || !BACKEND_URL) { return; }
  var params = new URLSearchParams(window.location.search);
  if (params.get("betaald") !== "1") { return; }

  sectie.hidden = false;
  sectie.style.display = "flex";
  sectie.classList.remove("betaald");
  if (titel) { titel.textContent = "Terug van het betalen"; }
  if (icoon) { icoon.classList.remove("gedaan", "stop"); icoon.textContent = ""; }
  if (knop) { knop.hidden = false; knop.style.display = ""; }
  if (knopSite) { knopSite.hidden = true; }
  var form = document.getElementById("aanvraagForm");
  if (form) { form.hidden = true; form.style.display = "none"; }

  function koppelOpnieuwKnop() {
    var opnieuwKnop = document.getElementById("mollieOpnieuw");
    if (opnieuwKnop) {
      opnieuwKnop.addEventListener("click", function (e) {
        e.preventDefault();
        vraagBetaallinkOp(true);
      });
    }
  }

  function toonGelukt() {
    sectie.classList.add("betaald");
    if (titel) { titel.textContent = "Betaling geslaagd"; }
    if (icoon) { icoon.classList.add("gedaan"); icoon.textContent = "\u2713"; }
    if (knop) { knop.hidden = true; knop.style.display = "none"; }
    if (knopSite) { knopSite.hidden = false; }
    if (tekst) {
      tekst.innerHTML = "Uw betaling van &euro;5 is ontvangen. Uw duplicaatvergunning " +
        "wordt zo snel mogelijk voor u <strong>aangemaakt en verstuurd</strong>.";
    }
  }

  var poging = 0;
  function opnieuw(wachten) {
    if (poging >= TERUG_POGINGEN) {
      if (icoon) { icoon.classList.add("stop"); icoon.textContent = "?"; }
      if (tekst) {
        tekst.innerHTML = "Wij hebben uw betaling nog niet binnen. Het kan zijn dat uw bank het nog verwerkt. Kies <em>Controleer nu</em> om het opnieuw te proberen. Is de betaling niet gelukt? Vraag dan <a href=\"#\" id=\"mollieOpnieuw\">een nieuwe betaallink</a> of mail ons uw referentie.";
        koppelOpnieuwKnop();
      }
      return;
    }
    if (wachten) {
      if (tekst) {
        tekst.innerHTML = "Wij controleren uw betaling automatisch nog even (poging " +
          (poging + 1) + " van " + TERUG_POGINGEN + ")...";
      }
      setTimeout(function () { opnieuw(false); }, TERUG_INTERVAL);
      return;
    }
    poging++;
    backendJsonp("status", "ref=" + encodeURIComponent(ref), 20000)
      .then(function (data) {
        var status = data && data.status ? String(data.status) : "";
        if (status === "paid" || status === "authorized") {
          toonGelukt();
          return;
        }
        if (tekst) {
          tekst.innerHTML = "Wij hebben uw betaling nog niet binnen; uw bank verwerkt die nog. Wij controleren automatisch opnieuw.";
        }
        opnieuw(true);
      })
      .catch(function () { opnieuw(true); });
  }

  opnieuw(false);
}

/* ------------------------------------------------------------
   Referenties en basisgegevens
   ------------------------------------------------------------ */
function maakReferentie() {
  var t = new Date();
  var deel1 = t.getTime().toString(36).toUpperCase().slice(-6);
  var deel2 = Math.random().toString(36).toUpperCase().slice(2, 6);
  return "DUP-" + deel1 + "-" + deel2;
}

function maakAanvraagId() {
  var t = new Date();
  var deel1 = t.getTime().toString(36).toUpperCase().slice(-6);
  var deel2 = Math.random().toString(36).toUpperCase().slice(2, 6);
  return "AV-" + deel1 + "-" + deel2;
}

function terugUrl() {
  return String(window.location.href || "").split(/[?#]/)[0];
}

function naB64url(tekst) {
  var s = String(tekst || "");
  var bin;
  if (typeof TextEncoder !== "undefined") {
    var bytes = new TextEncoder().encode(s);
    bin = "";
    for (var i = 0; i < bytes.length; i++) { bin += String.fromCharCode(bytes[i]); }
  } else {
    bin = unescape(encodeURIComponent(s));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function wacht(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/* ------------------------------------------------------------
   Versturen
   ------------------------------------------------------------ */
function verstuurAanvraag(aanvraag) {
  var lichaam = JSON.stringify(aanvraag);
  var params = "data=" + encodeURIComponent(naB64url(lichaam)) +
    "&terug=" + encodeURIComponent(terugUrl());

  function poging(nummer) {
    return backendJsonp("aanvraag", params, VERZEND_TIMEOUT_MS).then(function (antwoord) {
      if (!antwoord || antwoord.ok !== true) {
        throw new Error(String((antwoord && antwoord.fout) || "onbekend antwoord van de backend"));
      }
      return antwoord;
    }).catch(function (fout) {
      /* Een timeout of een 404 betekent niet dat de aanvraag kwijt is:
         de backend mailt maar één keer per aanvraag-id, dus nog een
         keer sturen kan geen kwaad. Tussendoor even navragen of hij al
         binnen is. */
      if (nummer >= VERZEND_POGINGEN - 1) { throw fout; }
      return controleerOntvangen(aanvraag.aanvraagId, 1, 8000).then(function (binnen) {
        if (binnen) { return { ok: true, alBinnen: true, referentie: aanvraag.aanvraagId }; }
        return wacht(1200).then(function () {
          toonStatus("Verbinding mislukt, opnieuw proberen (" + (nummer + 2) +
            " van " + VERZEND_POGINGEN + ")...", "info");
          return poging(nummer + 1);
        });
      });
    });
  }
  return poging(0);
}

function controleerOntvangen(id, pogingen, timeoutMs) {
  if (!id) { return Promise.resolve(false); }
  var maxPogingen = pogingen || 3;
  function vraag(poging) {
    return backendJsonp("bekend", "ref=" + encodeURIComponent(id), timeoutMs || 15000)
      .then(function (antwoord) {
        if (!antwoord) { return false; }
        return !!(antwoord.gevonden || antwoord.gekend);
      })
      .catch(function () {
        if (poging < maxPogingen - 1) {
          return wacht(1500).then(function () { return vraag(poging + 1); });
        }
        return false;
      });
  }
  return vraag(0);
}

/* ------------------------------------------------------------
   Formulier uitlezen en controleren
   ------------------------------------------------------------ */
function verzamelAanvraag() {
  function waarde(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : "";
  }
  function radioWaarde(naam) {
    var r = document.querySelector('input[name="' + naam + '"]:checked');
    return r ? r.value : "";
  }
  function checkbox(id) {
    var el = document.getElementById(id);
    return el ? el.checked : false;
  }

  var voorwaardenOk = checkbox("voorwaardenCheckbox");

  return {
    type: "aanvraag-autovergunning-site",
    soortAanvraag:   radioWaarde("soortAanvraag"),
    datumAanvraag:   waarde("datumAanvraag"),
    voorletters:     waarde("voorletters"),
    voornaam:        waarde("voornaam"),
    achternaam:      waarde("achternaam"),
    geboortedatum:   waarde("geboortedatum"),
    vispasnummer:    waarde("vispasnummer"),
    emailAdres:      waarde("emailAdres"),
    invalidenkaart:  radioWaarde("invalidenkaart"),
    invalidenkaartNummer: waarde("invalidenkaartNummer"),
    borgAkkoord:     checkbox("borgAkkoord"),
    duplicaatKostenAkkoord: checkbox("duplicaatKostenAkkoord"),
    avgAkkoord:      checkbox("avgAkkoord"),
    voorwaardenCheckbox: voorwaardenOk,
    voorwaardenRadio: voorwaardenOk ? "ja" : ""
  };
}

function controleerAanvraag() {
  var form = document.getElementById("aanvraagForm");

  if (!form.checkValidity()) {
    toonStatus("Er zijn nog verplichte velden niet (goed) ingevuld. Verbeter de velden met een rode rand.", "fout");
    form.reportValidity();
    return false;
  }

  var soort = document.querySelector('input[name="soortAanvraag"]:checked');
  if (!soort) {
    toonStatus("Maak een keuze: een nieuwe vergunning of een duplicaat vergunning.", "fout");
    form.reportValidity();
    return false;
  }

  var invalide = document.querySelector('input[name="invalidenkaart"]:checked');

  if (soort.value !== "duplicaat") {
    if (!invalide) {
      toonStatus("Geef aan of u een invalidenkaart heeft.", "fout");
      form.reportValidity();
      return false;
    }
    if (invalide.value === "nee") {
      toonStatus("U komt niet in aanmerking voor een Autovergunning: een invalidenkaart is minimaal verplicht voor een aanvraag.", "fout");
      return false;
    }
    if (!document.getElementById("invalidenkaartNummer").value.trim()) {
      toonStatus("Vul het nummer van uw invalidenkaart in.", "fout");
      document.getElementById("invalidenkaartNummer").focus();
      return false;
    }
  }

  var borg = document.getElementById("borgAkkoord");
  var dupKosten = document.getElementById("duplicaatKostenAkkoord");
  if (soort.value === "duplicaat") {
    toonAls(document.getElementById("borgAkkoordFout"), false);
    toonAls(document.getElementById("duplicaatKostenAkkoordFout"), !dupKosten.checked);
    if (!dupKosten.checked) {
      toonStatus("U komt niet in aanmerking: het akkoord dat er €5 in rekening wordt gebracht is minimaal verplicht voor een duplicaat vergunning.", "fout");
      return false;
    }
  } else {
    toonAls(document.getElementById("duplicaatKostenAkkoordFout"), false);
    toonAls(document.getElementById("borgAkkoordFout"), !borg.checked);
    if (!borg.checked) {
      toonStatus("U komt niet in aanmerking voor een Autovergunning: het akkoord dat er €25 borg voor de sleutel in rekening wordt gebracht is minimaal verplicht.", "fout");
      return false;
    }
  }

  var avg = document.getElementById("avgAkkoord");
  toonAls(document.getElementById("avgAkkoordFout"), !avg.checked);
  if (!avg.checked) {
    toonStatus("Het akkoord met de AVG is minimaal verplicht om de aanvraag te kunnen verzenden.", "fout");
    return false;
  }

  var voorwBox = document.getElementById("voorwaardenCheckbox");
  toonAls(document.getElementById("voorwaardenCheckboxFout"), !voorwBox.checked);
  if (!voorwBox.checked) {
    toonStatus("Het accepteren van de voorwaarden is minimaal verplicht om de aanvraag te kunnen verzenden.", "fout");
    return false;
  }

  return true;
}

/* ------------------------------------------------------------
   Bevestigingspagina
   ------------------------------------------------------------ */
function toonGeluktPagina(antwoord) {
  var form = document.getElementById("aanvraagForm");
  var sectie = document.getElementById("geluktPagina");
  if (sectie) { sectie.hidden = false; sectie.style.display = "block"; }
  if (form) { form.hidden = true; form.style.display = "none"; }

  var isDuplicaat = laatsteSoortAanvraag === "duplicaat";
  toonAls(document.getElementById("geluktNieuw"), !isDuplicaat);
  toonAls(document.getElementById("geluktDuplicaat"), isDuplicaat);

  var ref = (antwoord && antwoord.referentie) || laatsteRef;
  var refRegel = document.getElementById("bedanktReferentie");
  if (refRegel) {
    if (ref) {
      refRegel.innerHTML = "";
      refRegel.appendChild(document.createTextNode("Uw referentie: "));
      var sterk = document.createElement("strong");
      sterk.textContent = ref;
      refRegel.appendChild(sterk);
      refRegel.appendChild(document.createTextNode(" — bewaar deze bij vragen over uw aanvraag."));
      refRegel.hidden = false;
    } else {
      refRegel.hidden = true;
    }
  }

  if (isDuplicaat) {
    if (antwoord && antwoord.betaallink) {
      zetMollieKnop(antwoord.betaallink, "");
    } else {
      toonMollieStatus("De betaallink kon niet meteen worden aangemaakt" +
        (antwoord && antwoord.fout ? ": " + antwoord.fout : "") +
        ". Vraag hem hieronder opnieuw aan of mail ons.");
      var blok = document.getElementById("mollieBlok");
      if (blok) { blok.hidden = false; blok.style.display = "block"; }
    }
  }

  if (sectie && sectie.scrollIntoView) { sectie.scrollIntoView(); }
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------
   Verzenden op formulier
   ------------------------------------------------------------ */
function verstuurFormulier(e) {
  e.preventDefault();
  if (!controleerAanvraag()) { return; }

  var aanvraag = verzamelAanvraag();
  aanvraag.aanvraagId = maakAanvraagId();
  if (aanvraag.soortAanvraag === "duplicaat") {
    aanvraag.betaalReferentie = maakReferentie();
    aanvraag.aanvraagId = aanvraag.betaalReferentie;
    bewaarRef(aanvraag.betaalReferentie);
  } else {
    /* Ook de referentie tonen: de backend stuurt die niet terug, dus
       we gebruiken de aanvraag-id die we zelf hebben gemaakt. In
       sessionStorage mag hij niet staan: die is alleen voor een
       duplicaat dat nog terugkomt van Mollie. */
    laatsteRef = aanvraag.aanvraagId;
    try { sessionStorage.removeItem(REF_SLEUTEL); } catch (err) { /* geen opslag */ }
  }
  laatsteSoortAanvraag = aanvraag.soortAanvraag;

  if (!BACKEND_URL) {
    toonStatus("Dit formulier is nog niet gekoppeld aan de backend: vul BACKEND_URL in.", "fout");
    return;
  }

  toonStatus("Aanvraag wordt verstuurd...", "info");
  verstuurAanvraag(aanvraag).then(function (antwoord) {
    try {
      toonGeluktPagina(antwoord);
    } catch (fout) {
      toonStatus("Uw aanvraag is ontvangen, maar de bevestigingspagina kon niet getoond worden; ververs de pagina.", "info");
      return;
    }
    document.getElementById("aanvraagForm").reset();
  }).catch(function (fout) {
    var oorzaak = String((fout && fout.message) || "");
    console.error("Backendfout bij verzenden: " + oorzaak);
    /* Het formulier blijft gevuld: de aanvrager kan gewoon opnieuw
       proberen, en de backend stuurt per aanvraag-id maar één mail. */
    toonStatus(
      (oorzaak === "timeout" ? "De verbinding met de backend is traag. " : "Versturen is niet gelukt. ") +
      "Uw ingevulde gegevens zijn bewaard: probeer het over enkele seconden opnieuw, " +
      "of mail uw gegevens naar secretariaat@hsvderuisvoorn.nl.",
      "fout");
  });
}

/* ------------------------------------------------------------
   Datumvelden
   ------------------------------------------------------------ */
function stelVandaagIn() {
  var veld = document.getElementById("datumAanvraag");
  var kalender = document.getElementById("datumAanvraagKalender");
  var d = new Date();
  var tekst = (d.getDate() < 10 ? "0" : "") + d.getDate() + "-" +
    (d.getMonth() + 1 < 10 ? "0" : "") + (d.getMonth() + 1) + "-" + d.getFullYear();
  if (veld && !veld.value) { veld.value = tekst; }
  if (kalender && !kalender.value) {
    kalender.value = d.getFullYear() + "-" +
      (d.getMonth() + 1 < 10 ? "0" : "") + (d.getMonth() + 1) + "-" +
      (d.getDate() < 10 ? "0" : "") + d.getDate();
  }
}

function koppelKalender(tekstId, kalenderId) {
  var tekst = document.getElementById(tekstId);
  var kalender = document.getElementById(kalenderId);
  if (!tekst || !kalender) { return; }
  kalender.addEventListener("change", function () {
    if (!kalender.value) { return; }
    var delen = kalender.value.split("-");
    if (delen.length !== 3) { return; }
    tekst.value = delen[2] + "-" + delen[1] + "-" + delen[0];
  });
}

function zetDatumMasker(veld) {
  if (!veld) { return; }
  veld.addEventListener("input", function () {
    var cijfers = veld.value.replace(/[^0-9]/g, "").slice(0, 8);
    var uit = cijfers;
    if (cijfers.length > 4) {
      uit = cijfers.slice(0, 2) + "-" + cijfers.slice(2, 4) + "-" + cijfers.slice(4);
    } else if (cijfers.length > 2) {
      uit = cijfers.slice(0, 2) + "-" + cijfers.slice(2);
    }
    veld.value = uit;
  });
}

/* ------------------------------------------------------------
   Koppelen
   ------------------------------------------------------------ */
function koppelKlaarzetten() {
  var form = document.getElementById("aanvraagForm");
  if (!form) { return; }
  form.addEventListener("submit", verstuurFormulier);
  form.noValidate = true;

  stelVandaagIn();
  koppelKalender("datumAanvraag", "datumAanvraagKalender");
  koppelKalender("geboortedatum", "geboortedatumKalender");
  zetDatumMasker(document.getElementById("datumAanvraag"));
  zetDatumMasker(document.getElementById("geboortedatum"));

  /* nieuw: borg €25 · duplicaat: akkoord €5 en geen invalidenkaart */
  var kostenEl = document.getElementById("duplicaatKosten");
  var borgGroep = document.getElementById("borgGroep");
  var duplicaatGroep = document.getElementById("duplicaatGroep");
  var invalideVeld = document.getElementById("invalideVeld");

  function toonSoortGroepen() {
    var gekozen = document.querySelector('input[name="soortAanvraag"]:checked');
    var duplicaat = !!(gekozen && gekozen.value === "duplicaat");
    toonAls(kostenEl, duplicaat);
    toonAls(borgGroep, !duplicaat);
    toonAls(duplicaatGroep, duplicaat);
    toonAls(invalideVeld, !duplicaat);
    if (duplicaat) {
      var b = document.getElementById("borgAkkoord");
      if (b) { b.checked = false; }
      document.querySelectorAll('input[name="invalidenkaart"]').forEach(function (r) { r.checked = false; });
      var inr = document.getElementById("invalidenkaartNummer");
      if (inr) { inr.value = ""; inr.required = false; }
    } else {
      var d = document.getElementById("duplicaatKostenAkkoord");
      if (d) { d.checked = false; }
    }
  }
  document.querySelectorAll('input[name="soortAanvraag"]').forEach(function (r) {
    r.addEventListener("change", toonSoortGroepen);
  });

  var geenBericht = document.getElementById("geenInvalideBericht");
  var invalideGroep = document.getElementById("invalideGroep");
  var invalideNummer = document.getElementById("invalidenkaartNummer");

  function toonInvalide() {
    var gekozen = document.querySelector('input[name="invalidenkaart"]:checked');
    var ja = !!(gekozen && gekozen.value === "ja");
    var nee = !!(gekozen && gekozen.value === "nee");
    toonAls(geenBericht, nee);
    toonAls(invalideGroep, ja);
    if (invalideNummer) {
      invalideNummer.required = ja;
      if (nee) { invalideNummer.value = ""; }
    }
  }
  document.querySelectorAll('input[name="invalidenkaart"]').forEach(function (r) {
    r.addEventListener("change", toonInvalide);
  });

  function herstel(checkbox, foutP) {
    if (!checkbox) { return; }
    checkbox.addEventListener("change", function () {
      if (checkbox.checked && foutP) { foutP.hidden = true; }
    });
  }
  herstel(document.getElementById("borgAkkoord"), document.getElementById("borgAkkoordFout"));
  herstel(document.getElementById("duplicaatKostenAkkoord"), document.getElementById("duplicaatKostenAkkoordFout"));
  herstel(document.getElementById("avgAkkoord"), document.getElementById("avgAkkoordFout"));
  herstel(document.getElementById("voorwaardenCheckbox"), document.getElementById("voorwaardenCheckboxFout"));

  /* betaallink kopiëren */
  var kopieerbaar = document.querySelectorAll("[data-kopieer]");
  Array.prototype.forEach.call(kopieerbaar, function (el) {
    el.addEventListener("click", function () {
      if (el.getAttribute("data-kopieer") !== "mollielink" || !laatsteMollieUrl) { return; }
      kopieerTekst(laatsteMollieUrl).then(function (gelukt) {
        toonMollieStatus(gelukt ? "Betaallink is gekopieerd." : "Kopiëren lukte niet. Selecteer de link hierboven zelf.");
      });
    });
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        el.click();
      }
    });
  });

  var vernieuwen = document.getElementById("mollieVernieuwenBtn");
  if (vernieuwen) {
    vernieuwen.addEventListener("click", function () { vraagBetaallinkOp(true); });
  }

  var terugStatusKnop = document.getElementById("terugStatusKnop");
  if (terugStatusKnop) {
    terugStatusKnop.addEventListener("click", controleerBetaalstatus);
  }
  controleerBetaalstatus();
}

function kopieerTekst(tekst) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(tekst).then(function () { return true; })
      .catch(function () { return kopieerMetFallback(tekst); });
  }
  return Promise.resolve(kopieerMetFallback(tekst));
}

function kopieerMetFallback(tekst) {
  try {
    var veld = document.createElement("textarea");
    veld.value = tekst;
    veld.setAttribute("readonly", "");
    veld.style.position = "fixed";
    veld.style.opacity = "0";
    document.body.appendChild(veld);
    veld.select();
    var gelukt = document.execCommand("copy");
    document.body.removeChild(veld);
    return gelukt;
  } catch (fout) {
    return false;
  }
}

document.addEventListener("DOMContentLoaded", koppelKlaarzetten);
