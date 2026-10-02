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
var laatsteOvv = "";
var laatsteRef = "";

/* ------------------------------------------------------------
   Betaalgegevens duplicaat (EPC/SEPA QR en handmatige overboeking)
   ------------------------------------------------------------ */
var BANK_IBAN = "NL09RABO0141976950";
var BANK_IBAN_ZICHTBAAR = "NL09 RABO 0141 9769 50";
var BANK_NAAM = "Hengelsportver. De Ruisvoorn";
var DUPLICAAT_BEDRAG = "5.00";
var QR_SERVICE = "https://api.qrserver.com/v1/create-qr-code/";

function maakReferentie() {
  var t = new Date();
  var deel1 = t.getTime().toString(36).toUpperCase().slice(-6);
  var deel2 = Math.random().toString(36).toUpperCase().slice(2, 6);
  return "DUP-" + deel1 + "-" + deel2;
}

function maakOvv(a) {
  var naam = ((a.voornaam || "") + " " + (a.achternaam || "")).trim();
  var basis = "Duplicaat Autovergunning " + naam;
  var ref = a.betaalReferentie || "";
  if (ref) { basis = ref + " " + basis; }
  return basis.trim().slice(0, 140);
}

/* EPC QR-overboekingstekst (SEPA), herkend door Nederlandse bankapps */
function maakEpcQr(ovv) {
  return [
    "BCD",
    "002",
    "1",
    "SCT",
    "",                                   /* BIC (leeg, bank vult in)   */
    BANK_NAAM,                            /* begunstigde                */
    BANK_IBAN,                            /* rekeningnummer (geen spaties) */
    "EUR" + DUPLICAAT_BEDRAG,             /* bedrag                     */
    "",                                   /* purpose (leeg)             */
    ovv || "",                            /* o.v.v.                     */
    ""                                    /* extra (leeg)               */
  ].join("\n");
}

function vulBetaalgegevensIn() {
  var ovv = laatsteOvv || "Duplicaat Autovergunning";
  var img = document.getElementById("qrDuplicaat");
  if (img) {
    img.src = QR_SERVICE + "?size=300x300&data=" +
      encodeURIComponent(maakEpcQr(ovv)) + "&margin=0";
    img.hidden = false;
  }
  var o1 = document.getElementById("qrOvv");
  var o2 = document.getElementById("qrOvvHandmatig");
  if (o1) { o1.textContent = ovv; }
  if (o2) { o2.textContent = ovv; }
  var re = document.getElementById("qrRef");
  if (re) { re.textContent = laatsteRef || "&mdash;"; }
}

/* Melding 'betaling gedaan' (alleen bij duplicaat via de QR) naar
   de backend sturen. */
function verstuurBetaalMelding() {
  var btn = document.getElementById("betaalGemeldBtn");
  function toonMeldStatus(t, soort) {
    var el = document.getElementById("betaalGemeldStatus");
    if (!el) { return; }
    el.hidden = false;
    el.style.display = "block";
    el.textContent = t;
    el.className = "hulp-tekst" + (soort ? " " + soort : "");
  }
  if (!laatsteRef) {
    toonMeldStatus("Geen betaalreferentie gevonden. Mail secretariaat@hsvderuisvoorn.nl.", "fout");
    return;
  }
  if (btn) { btn.disabled = true; }
  toonMeldStatus("Bevestiging wordt verstuurd...", "");
  fetch(BACKEND_URL, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ type: "betaling-gemeld", betaalReferentie: laatsteRef })
  }).then(function () {
    toonMeldStatus("Bedankt! Uw betaling is doorgegeven; de club verwerkt het nu en stuurt de duplicaat zo snel mogelijk toe.", "ok");
  }).catch(function () {
    if (btn) { btn.disabled = false; }
    toonMeldStatus("Geen verbinding. Probeer het zo meteen nog eens of mail secretariaat@hsvderuisvoorn.nl met uw betaalreferentie " + laatsteRef + ".", "fout");
  });
}

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
  veld.value = d + "-" + m + "-" + j;
}

/* Gekozen datum uit de kalender (jjjj-mm-dd) overzetten naar het
   handmatige veld (dd-mm-jjjj). */
function koppelKalender(tekstId, kalenderId) {
  var tekst = document.getElementById(tekstId);
  var kal = document.getElementById(kalenderId);
  if (!tekst || !kal) { return; }
  kal.addEventListener("change", function () {
    var v = kal.value;
    if (!v) { return; }
    var delen = v.split("-");
    if (delen.length === 3) {
      tekst.value = delen[2] + "-" + delen[1] + "-" + delen[0];
      kal.value = "";
    }
  });
}

/* Zet automatisch streepjes tussen de datum tijdens het typen:
   19061967  ->  19-06-1967 */
function zetDatumMasker(veld) {
  if (!veld) { return; }
  veld.addEventListener("input", function () {
    var cijfers = veld.value.replace(/\D/g, "").slice(0, 8);
    var resultaat = "";
    if (cijfers.length > 4) {
      resultaat = cijfers.slice(0, 2) + "-" + cijfers.slice(2, 4) + "-" + cijfers.slice(4);
    } else if (cijfers.length > 2) {
      resultaat = cijfers.slice(0, 2) + "-" + cijfers.slice(2);
    } else {
      resultaat = cijfers;
    }
    if (veld.value !== resultaat) { veld.value = resultaat; }
  });
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
  if (sectie) {
    sectie.hidden = false;
    sectie.style.display = "block";
  }
  if (form) {
    form.hidden = true;
    form.style.display = "none";
  }
  var isDuplicaat = laatsteSoortAanvraag === "duplicaat";
  var nieuw = document.getElementById("geluktNieuw");
  var duplicaat = document.getElementById("geluktDuplicaat");
  if (nieuw)     { nieuw.hidden = isDuplicaat; }
  if (duplicaat) { duplicaat.hidden = !isDuplicaat; }
  if (isDuplicaat) { vulBetaalgegevensIn(); }
  if (sectie && sectie.scrollIntoView) { sectie.scrollIntoView(); }
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
      laatsteSoortAanvraag = item.soortAanvraag || "";
      laatsteRef = item.betaalReferentie || "";
      laatsteOvv = maakOvv(item);
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
      toonGeluktPagina();
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

  var soort = document.querySelector('input[name="soortAanvraag"]:checked');
  if (!soort) {
    toonStatus("Maak een keuze: een nieuwe vergunning of een duplicaat vergunning.", "fout");
    form.reportValidity();
    return false;
  }

  var invalide = document.querySelector('input[name="invalidenkaart"]:checked');

  /* 1) alleen bij een NIEUWE vergunning is een invalidenkaart
        minimaal verplicht; bij duplicaat niet van toepassing */
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

  /* 2) soort aanvraag: nieuw → borg €25, duplicaat → €5 in rekening */
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

  /* 3) AVG-akkoord */
  var avg = document.getElementById("avgAkkoord");
  toonAls(document.getElementById("avgAkkoordFout"), !avg.checked);
  if (!avg.checked) {
    toonStatus("Het akkoord met de AVG is minimaal verplicht om de aanvraag te kunnen verzenden.", "fout");
    return false;
  }

  /* 4) akkoord voorwaarden (checkbox) */
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
  if (aanvraag.soortAanvraag === "duplicaat") {
    aanvraag.betaalReferentie = maakReferentie();
    laatsteRef = aanvraag.betaalReferentie;
  } else {
    laatsteRef = "";
  }
  laatsteSoortAanvraag = aanvraag.soortAanvraag;
  laatsteOvv = maakOvv(aanvraag);

  if (!BACKEND_URL) {
    aanvraag.wachtrijId = "av-" + Date.now() + "-" +
      Math.random().toString(36).slice(2, 8);
    bewaarWachtrij(haalWachtrij().concat([aanvraag]));
    toonStatus("Uw aanvraag is bewaard. Zodra de backend is ingesteld wordt hij automatisch verstuurd.", "info");
    return;
  }

  toonStatus("Aanvraag wordt verstuurd...", "info");
  verstuurAanvraag(aanvraag).then(function () {
    try {
      toonGeluktPagina();
      resetFormulier();
    } catch (err) {
      toonStatus("Uw aanvraag is verstuurd en is in goede orde ontvangen. De bevestigingspagina kon niet getoond worden; ververs de pagina.", "info");
    }
  }).catch(function () {
    aanvraag.wachtrijId = "av-" + Date.now() + "-" +
      Math.random().toString(36).slice(2, 8);
    bewaarWachtrij(haalWachtrij().concat([aanvraag]));
    toonStatus("Geen verbinding: uw aanvraag is opgeslagen en wordt automatisch verzonden zodra u weer online bent. U krijgt dan ook de bevestiging te zien.", "info");
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

  /* kalender naar handmatig datumveld koppelen */
  koppelKalender("datumAanvraag", "datumAanvraagKalender");
  koppelKalender("geboortedatum", "geboortedatumKalender");

  /* automatische streepjes in datumvelden */
  zetDatumMasker(document.getElementById("datumAanvraag"));
  zetDatumMasker(document.getElementById("geboortedatum"));

  /* nieuw/duplicaat: borg €25 (nieuw) versus €5-akkoord (duplicaat),
   en bij duplicaat is de invalidenkaart niet van toepassing */
  var kostenEl = document.getElementById("duplicaatKosten");
  var borgGroep = document.getElementById("borgGroep");
  var duplicaatGroep = document.getElementById("duplicaatGroep");
  var invalideVeld = document.getElementById("invalideVeld");
  function toonSoortGroepen() {
    var gekozen = document.querySelector('input[name="soortAanvraag"]:checked');
    var duplicaat = !!(gekozen && gekozen.value === "duplicaat");
    if (kostenEl) { kostenEl.hidden = !duplicaat; }
    if (borgGroep) { borgGroep.hidden = duplicaat; }
    if (duplicaatGroep) { duplicaatGroep.hidden = !duplicaat; }
    if (invalideVeld) { invalideVeld.hidden = duplicaat; }
    if (duplicaat) {
      var b = document.getElementById("borgAkkoord");
      if (b) { b.checked = false; }
      document.querySelectorAll('input[name="invalidenkaart"]').forEach(function (r) {
        r.checked = false;
      });
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

  /* kopieer betaalgegevens (duplicaat) */
  var kopieerBtn = document.getElementById("kopieerBetaalBtn");
  if (kopieerBtn) {
    kopieerBtn.addEventListener("click", function () {
      var ovv = laatsteOvv || "Duplicaat Autovergunning";
      var tekst = "Betaalgegevens duplicaat Autovergunning\n" +
        "Rekeningnummer: " + BANK_IBAN_ZICHTBAAR + "\n" +
        "t.n.v.: " + BANK_NAAM + "\n" +
        "Bedrag: EUR " + DUPLICAAT_BEDRAG + "\n" +
        "o.v.v.: " + ovv;
      function klaar() {
        var st = document.getElementById("kopieerStatus");
        if (st) {
          st.hidden = false;
          st.style.display = "block";
          setTimeout(function () { if (st) { st.hidden = true; } }, 3000);
        }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tekst).then(klaar).catch(function () { klaar(); });
      } else {
        var ta = document.createElement("textarea");
        ta.value = tekst;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch (e) { /* niets */ }
        document.body.removeChild(ta);
        klaar();
      }
    });
  }

  /* 'ik heb betaald' melding versturen (duplicaat via QR) */
  var betaalGemeldBtn = document.getElementById("betaalGemeldBtn");
  if (betaalGemeldBtn) {
    betaalGemeldBtn.addEventListener("click", verstuurBetaalMelding);
  }

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