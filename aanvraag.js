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

var BACKEND_URL = "https://script.google.com/macros/s/AKfycbx57f06SZtgcePHBfufXbDmgO0MwBCjv4uCUGrdKwo_4cPmX7Vo7XlLRI47YmgUdrbS/exec";

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
var REF_SLEUTEL = "hsvDuplicaatRef";

/* Vraagt de backend (JSONP, want de Apps Script-webapp stuurt geen
   CORS-headers) om de actuele betaallink of betaalstatus op te halen. */
function backendJsonp(act, params) {
  return new Promise(function (resolve, reject) {
    if (!BACKEND_URL) { reject(new Error("geen backend")); return; }
    var cb = "hsvCb" + Date.now() + Math.floor(Math.random() * 1000);
    var script = document.createElement("script");
    var timer = setTimeout(function () {
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (script.parentNode) { script.parentNode.removeChild(script); }
      reject(new Error("timeout"));
    }, 12000);
    window[cb] = function (data) {
      clearTimeout(timer);
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (script.parentNode) { script.parentNode.removeChild(script); }
      resolve(data || {});
    };
    script.onerror = function () {
      clearTimeout(timer);
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (script.parentNode) { script.parentNode.removeChild(script); }
      reject(new Error("netwerk"));
    };
    script.src = BACKEND_URL + "?act=" + act + "&callback=" + cb +
      "&" + (params || "");
    document.head.appendChild(script);
  });
}

function bewaarRef(ref) {
  laatsteRef = ref || laatsteRef;
  try {
    if (laatsteRef) { sessionStorage.setItem(REF_SLEUTEL, laatsteRef); }
  } catch (e) { /* opslag niet beschikbaar */ }
}

function haalRefOp() {
  try { return sessionStorage.getItem(REF_SLEUTEL) || ""; } catch (e) { return ""; }
}

function toonMollieStatus(bericht) {
  var el = document.getElementById("mollieStatus");
  if (!el) { return; }
  if (!bericht) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.textContent = bericht;
  el.hidden = false;
}

/* Haalt de iDEAL-betaallink op en toont de grote betaalknop. */
function vraagBetaallinkOp(nieuw) {
  var blok = document.getElementById("mollieBlok");
  var knop = document.getElementById("mollieKnop");
  var ref = laatsteRef || haalRefOp();
  if (!blok || !knop || !ref || !BACKEND_URL) { return; }
  toonMollieStatus(nieuw ? "Een nieuwe betaallink wordt aangemaakt..." : "Betaallink ophalen...");
  backendJsonp("betaallink", "ref=" + encodeURIComponent(ref) + "&nieuw=" + (nieuw ? "1" : "0"))
    .then(function (data) {
      var url = data && data.url ? data.url : "";
      if (!url) {
        blok.hidden = true;
        toonMollieStatus("");
        return;
      }
      knop.href = url;
      blok.hidden = false;
      toonMollieStatus(data.nieuw ? "Nieuwe betaallink aangemaakt." : "");
    })
    .catch(function () {
      blok.hidden = true;
      toonMollieStatus("");
    });
}

/* Controleert na terugkomst van Mollie of de betaling binnen is. */
function controleerBetaalstatus() {
  var sectie = document.getElementById("terugVanBetaling");
  var tekst = document.getElementById("terugTekst");
  var ref = haalRefOp();
  if (!sectie || !ref || !BACKEND_URL) { return; }
  var params = new URLSearchParams(window.location.search);
  if (params.get("betaald") !== "1") { return; }
  sectie.hidden = false;
  sectie.style.display = "block";
  var form = document.getElementById("aanvraagForm");
  if (form) { form.hidden = true; form.style.display = "none"; }
  backendJsonp("status", "ref=" + encodeURIComponent(ref))
    .then(function (data) {
      var status = data && data.status ? String(data.status) : "";
      if (status === "paid" || status === "authorized") {
        if (tekst) {
          tekst.innerHTML = "Uw betaling van &euro;5 is ontvangen. Uw aanvraag voor een duplicaat is daarmee afgerond; u ontvangt de duplicaat zo snel mogelijk per post.";
        }
        return;
      }
      if (tekst) {
        tekst.innerHTML = "Wij hebben uw betaling nog niet binnen. Het kan zijn dat uw bank het nog verwerkt. Kies <em>Controleer nu</em> om het opnieuw te proberen. Is de betaling niet gelukt? Gebruik dan de QR-code of de betaalgegevens, of mail ons uw betaalreferentie.";
      }
    })
    .catch(function () {
      if (tekst) {
        tekst.innerHTML = "Wij konden uw betalingstatus niet ophalen. Controleer dit later opnieuw, of mail ons uw betaalreferentie.";
      }
    });
}

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
  var qrUrl = QR_SERVICE + "?size=300x300&data=" +
    encodeURIComponent(maakEpcQr(ovv)) + "&margin=0";
  var img = document.getElementById("qrDuplicaat");
  if (img) {
    img.src = qrUrl;
    img.hidden = false;
  }
  var link = document.getElementById("qrLinkDuplicaat");
  if (link) {
    link.href = qrUrl;
    link.hidden = false;
  }
  var o1 = document.getElementById("qrOvv");
  var o2 = document.getElementById("qrOvvHandmatig");
  if (o1) { o1.textContent = ovv; }
  if (o2) { o2.textContent = ovv; }
  var re = document.getElementById("qrRef");
  if (re) { re.textContent = laatsteRef || "&mdash;"; }
}

function kopieerTekst(tekst) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(tekst).then(function () {
      return true;
    }).catch(function () {
      return kopieerTekstMetFallback(tekst);
    });
  }
  return kopieerTekstMetFallback(tekst);
}

function kopieerTekstMetFallback(tekst) {
  var ta = document.createElement("textarea");
  ta.value = tekst;
  ta.setAttribute("readonly", "readonly");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.padding = "0";
  ta.style.border = "none";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, tekst.length);
  var gelukt = false;
  try { gelukt = document.execCommand("copy"); } catch (e) { gelukt = false; }
  document.body.removeChild(ta);
  return Promise.resolve(gelukt);
}

function toonKopieerStatus(bericht) {
  var st = document.getElementById("kopieerStatus");
  if (!st) { return; }
  st.textContent = bericht;
  st.hidden = false;
  st.style.display = "block";
  if (st._timer) { clearTimeout(st._timer); }
  st._timer = setTimeout(function () {
    st.hidden = true;
    st.textContent = "Betaalgegevens zijn gekopieerd.";
  }, 3000);
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
  if (isDuplicaat) {
    vulBetaalgegevensIn();
    vraagBetaallinkOp(false);
  }
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
      bewaarRef(laatsteRef);
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
    bewaarRef(laatsteRef);
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
      kopieerTekst(tekst).then(function (gelukt) {
        toonKopieerStatus(gelukt
          ? "Betaalgegevens zijn gekopieerd."
          : "Kopiëren lukte niet. Selecteer de gegevens hierboven zelf.");
      });
    });
  }

  /* afzonderlijke betaalgegevens kopiëren (tikken op mobiel) */
  var kopieerbaar = document.querySelectorAll("[data-kopieer]");
  Array.prototype.forEach.call(kopieerbaar, function (el) {
    function kopieerWaarde() {
      var soort = el.getAttribute("data-kopieer");
      var waarde = "";
      var label = "";
      if (soort === "iban") {
        waarde = BANK_IBAN;
        label = "Rekeningnummer is gekopieerd.";
      } else if (soort === "bedrag") {
        waarde = DUPLICAAT_BEDRAG;
        label = "Bedrag is gekopieerd.";
      } else if (soort === "ovv") {
        waarde = laatsteOvv || el.textContent || "";
        label = "O.v.v. is gekopieerd.";
      }
      if (!waarde) { return; }
      kopieerTekst(waarde).then(function (gelukt) {
        toonKopieerStatus(gelukt
          ? label
          : "Kopiëren lukte niet. Selecteer het gegeven hierboven zelf.");
      });
    }
    el.addEventListener("click", kopieerWaarde);
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        kopieerWaarde();
      }
    });
  });

  /* 'ik heb betaald' melding versturen (duplicaat via QR) */
  var betaalGemeldBtn = document.getElementById("betaalGemeldBtn");
  if (betaalGemeldBtn) {
    betaalGemeldBtn.addEventListener("click", verstuurBetaalMelding);
  }

  /* nieuwe iDEAL-betaallink opvragen */
  var mollieVernieuwenBtn = document.getElementById("mollieVernieuwenBtn");
  if (mollieVernieuwenBtn) {
    mollieVernieuwenBtn.addEventListener("click", function () {
      vraagBetaallinkOp(true);
    });
  }

  /* handmatig betalen / QR-code verbergen */
  var handmatigKnop = document.getElementById("handmatigKnop");
  var handmatigBlok = document.getElementById("handmatigBlok");
  if (handmatigKnop && handmatigBlok) {
    handmatigKnop.addEventListener("click", function () {
      var zichtbaar = !handmatigBlok.hidden;
      handmatigBlok.hidden = zichtbaar;
      handmatigBlok.style.display = zichtbaar ? "none" : "block";
      handmatigKnop.textContent = zichtbaar ? "Toon QR-code en betaalgegevens" : "Verberg deze optie";
    });
  }

  /* teruggekomen van Mollie: betaalstatus controleren */
  var terugStatusKnop = document.getElementById("terugStatusKnop");
  if (terugStatusKnop) {
    terugStatusKnop.addEventListener("click", controleerBetaalstatus);
  }
  controleerBetaalstatus();

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