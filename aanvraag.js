/* ============================================================
   Aanvraag Autovergunning - aanvraag.js
   ------------------------------------------------------------
   Verzamelt het ingevulde formulier en verstuurt het naar de
   Google Apps Script-backend (BACKEND_URL).

   OFFLINE-WACHTRIJ:
   - Als de backend niet bereikbaar is, wordt de aanvraag lokaal
     bewaard (localStorage, sleutel "wachtrijAutovergunning").
   - Zodra internet terugkeert (online-gebeurtenis) wordt de
     wachtrij automatisch doorverstuurd.

   LET OP (aan het eind van dit bestand):
   - BACKEND_URL op de waarde van jouw gepubliceerde Apps
     Script-webapp zetten; tot die tijd wordt elke aanvraag
     alleen in de offline-wachtrij bewaard.
   ============================================================ */

"use strict";

var BACKEND_URL = "https://script.google.com/macros/s/AKfycbzVFiPhXg3rM-IadQH0oBSIxqnXP45iXIo8dFcKcPq9eRK155VXXUi4nwuWluK2ogXQ/exec";

var WACHTRIJ_SLEUTEL = "wachtrijAutovergunning";
var laatsteSoortAanvraag = "";

/* ------------------------------------------------------------
   Standaard vandaag invullen bij "Datum aanvraag"
   ------------------------------------------------------------ */
function stelVandaagIn() {
  var veld = document.getElementById("datumAanvraag");
  if (!veld) { return; }
  var nu = new Date();
  var j = nu.getFullYear();
  var m = ("0" + (nu.getMonth() + 1)).slice(-2);
  var d = ("0" + nu.getDate()).slice(-2);
  veld.value = j + "-" + m + "-" + d;
}

/* ------------------------------------------------------------
   Wachtrij (offline-opslag)
   ------------------------------------------------------------ */
function haalWachtrij() {
  try {
    var ruw = localStorage.getItem(WACHTRIJ_SLEUTEL);
    return ruw ? JSON.parse(ruw) : [];
  } catch (e) {
    return [];
  }
}

function bewaarWachtrij(rij) {
  try {
    localStorage.setItem(WACHTRIJ_SLEUTEL, JSON.stringify(rij));
  } catch (e) { /* opslag niet beschikbaar (privacy-modus) */ }
}

/* ------------------------------------------------------------
   Statusmelding tonen
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

/* ------------------------------------------------------------
   Geluktpagina tonen na een succesvolle verzending
   ------------------------------------------------------------ */
function toonGeluktPagina() {
  var form = document.getElementById("aanvraagForm");
  var sectie = document.getElementById("geluktPagina");
  if (sectie) { sectie.hidden = false; }
  if (form)   { form.hidden = true; }
  var kosten = document.getElementById("geluktKostenTekst");
  if (kosten) {
    kosten.textContent = laatsteSoortAanvraag === "duplicaat"
      ? "Let op: toekenning is pas definitief na goedkeuring. De €5 voor de duplicaat vergunning wordt pas bij toekenning in rekening gebracht."
      : "Let op: toekenning is pas definitief na goedkeuring. De borg van €25 voor de sleutel wordt pas bij toekenning in rekening gebracht.";
  }
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------
   Verzoek naar de backend sturen (één aanvraag)
   ------------------------------------------------------------ */
function verstuurAanvraag(aanvraag) {
  if (!BACKEND_URL) {
    return Promise.reject(new Error("BACKEND_URL_LEEG"));
  }
  return fetch(BACKEND_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(aanvraag)
  }).then(function () {
    return "verstuurd";
  });
}

/* ------------------------------------------------------------
   Wachtrij doorsturen (zoveel mogelijk)
   ------------------------------------------------------------ */
function verstuurWachtrij() {
  var rij = haalWachtrij();
  if (!rij.length) { return Promise.resolve(0); }
  var beloften = rij.map(function (item) {
    return verstuurAanvraag(item).then(function () {
      var overig = haalWachtrij().filter(function (x) {
        return x.wachtrijId !== item.wachtrijId;
      });
      bewaarWachtrij(overig);
      return 1;
    }).catch(function () {
      return 0; /* niet gelukt, blijft in de wachtrij */
    });
  });
  return Promise.all(beloften).then(function (resultaten) {
    var geslaagd = resultaten.reduce(function (a, b) { return a + b; }, 0);
    if (geslaagd > 0 && !haalWachtrij().length) {
      toonStatus("Uw aanvraag is verstuurd en is in goede orde ontvangen.", "ok");
      resetFormulier();
    }
    return geslaagd;
  });
}

/* ------------------------------------------------------------
   Formulier leegmaken na succesvol verzenden
   ------------------------------------------------------------ */
function resetFormulier() {
  var form = document.getElementById("aanvraagForm");
  if (form) { form.reset(); }
}

/* ------------------------------------------------------------
   Uitlezen van het formulier
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

  return {
    type: "aanvraag-autovergunning",
    soortAanvraag:   radioWaarde("soortAanvraag"),
    datumAanvraag:   waarde("datumAanvraag"),
    voorletters:     waarde("voorletters"),
    voornaam:        waarde("voornaam"),
    achternaam:      waarde("achternaam"),
    geboortedatum:   waarde("geboortedatum"),
    vispasnummer:    waarde("vispasnummer"),
    invalidenkaart:  radioWaarde("invalidenkaart"),
    invalidenkaartNummer: waarde("invalidenkaartNummer"),
    voorwaardenRadio: radioWaarde("voorwaardenRadio"),
    borgAkkoord:     checkbox("borgAkkoord"),
    duplicaatKostenAkkoord: checkbox("duplicaatKostenAkkoord"),
    avgAkkoord:      checkbox("avgAkkoord"),
    voorwaardenCheckbox: checkbox("voorwaardenCheckbox")
  };
}

/* ------------------------------------------------------------
   Validatie met duidelijke blokkerende berichten
   ------------------------------------------------------------ */
function toonAls(el, zichtbaar) {
  if (el) { el.hidden = !zichtbaar; }
}

function controleerAanvraag() {
  var ok = true;
  var form = document.getElementById("aanvraagForm");

  /* verplichte tekstvelden + geldige data */
  if (!form.checkValidity()) {
    toonStatus("Er zijn nog verplichte velden niet (goed) ingevuld. Verbeter de velden met een rode rand.", "fout");
    form.reportValidity();
    return false;
  }

  var invalide = document.querySelector('input[name="invalidenkaart"]:checked');

  /* 1) invalidenkaart is minimaal verplicht */
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

  /* 2) akkoord voorwaarden (radio): nee = zelfde blokkade als invalidenkaart */
  var voorwRadio = document.querySelector('input[name="voorwaardenRadio"]:checked');
  toonAls(document.getElementById("voorwaardenBlokkeerBericht"), !voorwRadio || voorwRadio.value !== "ja");
  if (!voorwRadio) {
    toonStatus("Geef aan of u akkoord gaat met de voorwaarden.", "fout");
    return false;
  }
  if (voorwRadio.value === "nee") {
    toonStatus("U komt niet in aanmerking voor een Autovergunning: het accepteren van de voorwaarden is minimaal verplicht voor een aanvraag.", "fout");
    return false;
  }

  /* 3) soort aanvraag: nieuw → borg €25, duplicaat → €5 in rekening */
  var soort = document.querySelector('input[name="soortAanvraag"]:checked');
  if (!soort) {
    toonStatus("Maak een keuze: een nieuwe vergunning of een duplicaat vergunning.", "fout");
    form.reportValidity();
    return false;
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

  /* 4) AVG-akkoord */
  var avg = document.getElementById("avgAkkoord");
  toonAls(document.getElementById("avgAkkoordFout"), !avg.checked);
  if (!avg.checked) {
    toonStatus("Het akkoord met de AVG is minimaal verplicht om de aanvraag te kunnen verzenden.", "fout");
    return false;
  }

  /* 5) akkoord voorwaarden (checkbox) */
  var voorwBox = document.getElementById("voorwaardenCheckbox");
  toonAls(document.getElementById("voorwaardenCheckboxFout"), !voorwBox.checked);
  if (!voorwBox.checked) {
    toonStatus("Het accepteren van de voorwaarden is minimaal verplicht om de aanvraag te kunnen verzenden.", "fout");
    return false;
  }

  return ok;
}

function verstuurFormulier(e) {
  e.preventDefault();

  if (!controleerAanvraag()) {
    return;
  }

  var aanvraag = verzamelAanvraag();
  laatsteSoortAanvraag = aanvraag.soortAanvraag;

  if (!BACKEND_URL) {
    aanvraag.wachtrijId = "av-" + Date.now() + "-" +
      Math.random().toString(36).slice(2, 8);
    bewaarWachtrij(haalWachtrij().concat([aanvraag]));
    toonStatus("Uw aanvraag is bewaard. Zodra de backend is ingesteld wordt hij automatisch verstuurd.", "info");
    return;
  }

  toonStatus("Aanvraag wordt verstuurd...", "info");
  verstuurAanvraag(aanvraag).then(function () {
    toonGeluktPagina();
    resetFormulier();
  }).catch(function () {
    aanvraag.wachtrijId = "av-" + Date.now() + "-" +
      Math.random().toString(36).slice(2, 8);
    bewaarWachtrij(haalWachtrij().concat([aanvraag]));
    toonStatus("Geen verbinding (of de backend is nog niet ingesteld). De aanvraag is bewaard en wordt later automatisch verstuurd.", "info");
  });
}

/* ------------------------------------------------------------
   Koppel klaarzetten: velden tonen/verbergen + online-herstel
   ------------------------------------------------------------ */
function koppelKlaarzetten() {
  var form = document.getElementById("aanvraagForm");
  if (!form) { return; }
  form.addEventListener("submit", verstuurFormulier);
  form.noValidate = true;

  stelVandaagIn();

  /* nieuw/duplicaat: borg €25 (nieuw) versus €5-akkoord (duplicaat) */
  var kostenEl = document.getElementById("duplicaatKosten");
  var borgGroep = document.getElementById("borgGroep");
  var duplicaatGroep = document.getElementById("duplicaatGroep");
  function toonSoortGroepen() {
    var gekozen = document.querySelector('input[name="soortAanvraag"]:checked');
    var duplicaat = !!(gekozen && gekozen.value === "duplicaat");
    if (kostenEl) { kostenEl.hidden = !duplicaat; }
    if (borgGroep) { borgGroep.hidden = duplicaat; }
    if (duplicaatGroep) { duplicaatGroep.hidden = !duplicaat; }
    if (duplicaat) {
      var b = document.getElementById("borgAkkoord");
      if (b) { b.checked = false; }
    } else {
      var d = document.getElementById("duplicaatKostenAkkoord");
      if (d) { d.checked = false; }
    }
  }
  document.querySelectorAll('input[name="soortAanvraag"]').forEach(function (r) {
    r.addEventListener("change", toonSoortGroepen);
  });

  /* invalidenkaart = nee -> duidelijk bericht, ja -> nummer tonen */
  var geenBericht = document.getElementById("geenInvalideBericht");
  var invalideGroep = document.getElementById("invalideGroep");
  var invalideNummer = document.getElementById("invalidenkaartNummer");

  function toonInvalide() {
    var gekozen = document.querySelector('input[name="invalidenkaart"]:checked');
    var ja = !!(gekozen && gekozen.value === "ja");
    var nee = !!(gekozen && gekozen.value === "nee");
    if (geenBericht)   { geenBericht.hidden = !nee; }
    if (invalideGroep) { invalideGroep.hidden = !ja; }
    if (invalideNummer) {
      invalideNummer.required = ja;
      if (nee) { invalideNummer.value = ""; }
    }
  }
  document.querySelectorAll('input[name="invalidenkaart"]').forEach(function (r) {
    r.addEventListener("change", toonInvalide);
  });

  /* voorwaarden radio = nee -> zelfde blokkerende melding tonen */
  var voorwBlokkeer = document.getElementById("voorwaardenBlokkeerBericht");
  var voorwRadios = document.querySelectorAll('input[name="voorwaardenRadio"]');
  function toonVoorwBlokkade() {
    var gekozen = document.querySelector('input[name="voorwaardenRadio"]:checked');
    var nee = !!(gekozen && gekozen.value === "nee");
    if (voorwBlokkeer) { voorwBlokkeer.hidden = !nee; }
  }
  voorwRadios.forEach(function (r) {
    r.addEventListener("change", toonVoorwBlokkade);
  });

  /* foutmeldingen onder akkoord-velden verbergen zodra het rechtgezet wordt */
  function herstel(checkbox, foutP) {
    checkbox.addEventListener("change", function () {
      if (checkbox.checked) { if (foutP) { foutP.hidden = true; } }
    });
  }
  herstel(document.getElementById("borgAkkoord"), document.getElementById("borgAkkoordFout"));
  herstel(document.getElementById("duplicaatKostenAkkoord"), document.getElementById("duplicaatKostenAkkoordFout"));
  herstel(document.getElementById("avgAkkoord"), document.getElementById("avgAkkoordFout"));
  herstel(document.getElementById("voorwaardenCheckbox"), document.getElementById("voorwaardenCheckboxFout"));

  /* online -> wachtrij leegpompen */
  if ("ononline" in window) {
    window.addEventListener("online", function () {
      if (haalWachtrij().length) {
        verstuurWachtrij();
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", koppelKlaarzetten);