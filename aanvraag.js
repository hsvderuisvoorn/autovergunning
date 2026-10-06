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

var BACKEND_URL = "https://script.google.com/macros/s/AKfycbyGgzq52fmObOgDZndUQSKssPCwzFZz7wAiAmSSFZrauo2n9E7UZmK4naoUS6eZFIY/exec";

var WACHTRIJ_SLEUTEL = "wachtrijAutovergunning";
var laatsteSoortAanvraag = "";
var laatsteOvv = "";
var laatsteRef = "";
var laatsteMollieUrl = "";
/* Onthoudt de lopende ophalen-actie, zodat twee keer naar de link
   vragen (bijvoorbeeld bij een dubbele poging) niet twee orders bij
   Mollie maakt. */
var betaallinkBelofte = null;
var betaallinkBelofteRef = "";

/* Apps Script start koud op en doet zijn sheetbewerkingen in losse
   rondgangen. Eerdelijk was hier 20 seconden de grens, waardoor een
   aanvraag die netjes was weggeschreven toch als mislukt werd gemeld.
   Ruim er tijd voor; het opslaan zelf doet geen enkele aanroep naar
   een externe dienst meer. */
var VERZEND_TIMEOUT_MS = 45000;

/* Hoe vaak het versturen wordt herhaald voordat het naar de wachtrij
   gaat. Gemeten is dat de Apps Script-webapp soms een 404 geeft of
   meer dan dertig seconden duurt; met drie pogingen is dat zelden
   echt mislukt. Dubbele rijen worden door de backend voorkomen: die
   kijkt eerst of er al een rij met hetzelfde aanvraag-id bestaat. */
var VERZEND_POGINGEN = 3;

/* ------------------------------------------------------------
   Betaalgegevens duplicaat (EPC/SEPA QR en handmatige overboeking)
   ------------------------------------------------------------ */
var BANK_IBAN = "NL09RABO0141976950";
var BANK_IBAN_ZICHTBAAR = "NL09 RABO 0141 9769 50";
var BANK_NAAM = "Hengelsportver. De Ruisvoorn";
var DUPLICAAT_BEDRAG = "5.00";
var QR_SERVICE = "https://api.qrserver.com/v1/create-qr-code/";
var REF_SLEUTEL = "hsvDuplicaatRef";

/* Vraagt de backend (JSONP) om iets op te halen of op te slaan.
   Een POST vanuit de browser werkt niet bij een Apps Script-webapp:
   Google stuurt na de POST een redirect (302) en de browser verandert
   dat in een GET, waardoor doPost nooit draait. JSONP via een
   script-tag heeft dat probleem niet en werkt overal. */
function backendJsonp(act, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    if (!BACKEND_URL) { reject(new Error("geen backend")); return; }
    var cb = "hsvCb" + Date.now() + Math.floor(Math.random() * 1000);
    var script = document.createElement("script");
    var timer = setTimeout(function () {
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (script.parentNode) { script.parentNode.removeChild(script); }
      reject(new Error("timeout"));
    }, timeoutMs || VERZEND_TIMEOUT_MS);
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
  /* Ook in een cookie: die is per apparaat en dus beschikbaar als de
     aanvrager via iDEAL in een nieuw tabblad terechtkomt. */
  try {
    if (laatsteRef) {
      document.cookie = REF_SLEUTEL + "=" + encodeURIComponent(laatsteRef) +
        "; path=/; max-age=1800; SameSite=Lax";
    }
  } catch (e) { /* cookies niet beschikbaar */ }
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

/* Handmatig betalen (QR/overschrijven) zichtbaar maken of verbergen. */
function zetHandmatigBlok(zichtbaar) {
  var blok = document.getElementById("handmatigBlok");
  var knop = document.getElementById("handmatigKnop");
  var meld = document.getElementById("betaalMeldBlok");
  if (!blok) { return; }
  blok.hidden = !zichtbaar;
  blok.style.display = zichtbaar ? "block" : "none";
  if (knop) {
    knop.textContent = zichtbaar
      ? "Verberg deze optie"
      : "Toon QR-code en betaalgegevens";
  }
  /* 'ik heb overgemaakt' hoort alleen bij de handmatige route */
  if (meld) {
    meld.hidden = zichtbaar ? false : true;
    meld.style.display = zichtbaar ? "block" : "none";
  }
}

/* Zet de grote iDEAL-knop op een link. */
function zetMollieKnop(url, status) {
  var blok = document.getElementById("mollieBlok");
  var knop = document.getElementById("mollieKnop");
  if (!blok || !knop || !url) { return; }
  laatsteMollieUrl = url;
  knop.href = url;
  /* pas nu is de knop echt bruikbaar */
  knop.classList.remove("niet-klaar");
  knop.removeAttribute("aria-disabled");
  var tekst = document.getElementById("mollieUrlTekst");
  if (tekst) { tekst.textContent = url; }
  blok.hidden = false;
  blok.style.display = "block";
  toonMollieStatus(status || "");
}

/* Zet de knop zichtbaar, maar nog niet klikbaar. Zonder deze
   volgende regel zou een tik op de knop een leeg tabblad openen,
   omdat de link nog niet binnen is. */
function toonKnopNogNietKlaar() {
  var blok = document.getElementById("mollieBlok");
  var knop = document.getElementById("mollieKnop");
  if (blok && (laatsteRef || haalRefOp())) {
    blok.hidden = false;
    blok.style.display = "block";
  }
  if (!knop) { return; }
  /* De link kan al binnen zijn, omdat hij tijdens het versturen werd
     opgehaald. Dan mag de knop niet opnieuw onklaar worden gemaakt. */
  var huidig = knop.getAttribute("href");
  if (huidig && huidig !== "#") { return; }
  knop.classList.add("niet-klaar");
  knop.setAttribute("aria-disabled", "true");
}

/* Toont de betaalknop. Bij een duplicaat stuurt de backend de
   iDEAL-link mee in het antwoord van het versturen, zodat er maar één
   aanroep nodig is. Ontbreekt die (oudere backend, of een aanroep die
   vastliep), dan wordt de link hier alsnog opgehaald. */
function toonBetaallink(antwoord) {
  var url = String((antwoord && antwoord.betaallink) || "");
  if (url) {
    zetMollieKnop(url, "");
    return;
  }
  /* De knop is al van een eerdere ophalen-actie gevuld. */
  var knop = document.getElementById("mollieKnop");
  var klaar = knop ? String(knop.getAttribute("href") || "") : "";
  if (klaar && klaar !== "#") {
    zetMollieKnop(klaar, "");
    return;
  }
  /* toon meteen dat er aan gewerkt wordt, anders lijkt het stil */
  toonKnopNogNietKlaar();
  toonMollieStatus("De iDEAL-link wordt opgehaald...");
  vraagBetaallinkOp(false);
}

/* Haalt de iDEAL-betaallink op bij de backend, zonder de UI aan te
   raken. Extra ruimte: hier maakt de backend een order aan bij Mollie,
   en gemeten is dat de webapp zelf soms al dertig seconden duurt. */
function haalBetaallink(nieuw) {
  var ref = laatsteRef || haalRefOp();
  if (!ref || !BACKEND_URL) {
    return Promise.reject(new Error("geen referentie of backend"));
  }
  function poging(nummer) {
    return backendJsonp("betaallink",
      "ref=" + encodeURIComponent(ref) + "&nieuw=" + (nieuw ? "1" : "0"),
      90000).catch(function (fout) {
      /* Zelfde reden als bij het versturen van de aanvraag: de webapp
         geeft regelmatig een 404 of duurt lang. Opnieuw proberen, want
         een aanvrager die een lege pagina ziet denkt tot zover niet
         aan de betaling. */
      if (nummer < 2) {
        toonMollieStatus("Verbinding mislukt, opnieuw proberen...");
        return wacht(2000).then(function () { return poging(nummer + 1); });
      }
      throw fout;
    });
  }
  return poging(0);
}

/* Haalt de iDEAL-betaallink op en toont de grote betaalknop.
   In de gewone route zit de link al in het antwoord van het versturen;
   dit is de vangnet-route als die ontbreekt (oudere backend) of als de
   knop "nieuwe link" wordt gebruikt. */
function vraagBetaallinkOp(nieuw) {
  var ref = laatsteRef || haalRefOp();
  if (!ref || !BACKEND_URL) { return Promise.resolve(); }
  toonMollieStatus(nieuw ? "Een nieuwe betaallink wordt aangemaakt..." : "Betaallink ophalen...");
  toonKnopNogNietKlaar();
  /* Dezelfde ophalen-actie hergebruiken als die al liep: één order
     bij Mollie in plaats van twee. Nieuwe links gaan altijd apart. */
  var reuse = !nieuw && betaallinkBelofte && betaallinkBelofteRef === ref;
  var belofte = reuse ? betaallinkBelofte : haalBetaallink(nieuw);
  if (!nieuw) {
    betaallinkBelofte = belofte;
    betaallinkBelofteRef = ref;
  }
  return belofte
    .then(function (data) {
      var url = data && data.url ? data.url : "";
      if (!url) {
        var blok = document.getElementById("mollieBlok");
        if (blok) { blok.hidden = true; blok.style.display = "none"; }
        toonMollieStatus("");
        /* geen iDEAL-link? dan moet de handmatige optie zichtbaar zijn */
        zetHandmatigBlok(true);
        return;
      }
      zetMollieKnop(url, data.nieuw ? "Nieuwe betaallink aangemaakt." : "");
    })
    .catch(function (fout) {
      /* Mislukt: volgende keer mag er een verse poging gedaan worden. */
      if (!nieuw && betaallinkBelofte === belofte) { betaallinkBelofte = null; }
      /* De knop blijft staan, maar niet klikbaar, en er staat
         duidelijk waarom. Met de handmatige betaalgegevens kan de
         aanvrager in elk geval door. */
      var knop = document.getElementById("mollieKnop");
      if (knop) {
        knop.classList.add("niet-klaar");
        knop.setAttribute("aria-disabled", "true");
      }
      toonMollieStatus("De iDEAL-link kon niet worden opgehaald. " +
        "Tik op 'Vraag een nieuwe betaallink' hieronder, of gebruik de " +
        "betaalgegevens.");
      zetHandmatigBlok(true);
    });
}

/* ------------------------------------------------------------
   Controleert na terugkomst van Mollie of de betaling binnen is.
   ------------------------------------------------------------
   Banken laten een iDEAL-betaling meestal enkele seconden tot een
   minuut landen. Daarom wordt de status na terugkomst enkele keren
   automatisch opgehaald in plaats van één keer: de aanvrager hoeft
   niet zelf op 'Controleer nu' te klikken. Na de laatste poging
   blijft de knop staan voor het geval het langer duurt. */
var TERUG_POGINGEN = 6;      /* 6 x 2,5 s = maximaal 15 s       */
var TERUG_INTERVAL = 2500;

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
  /* 'Nieuwe betaallink' in de slottekst: die link wordt pas in de
     tekst gezet als het automatisch controleren niets opleverde. */
  function koppelOpnieuwKnop() {
    var knop = document.getElementById("mollieOpnieuw");
    if (knop) {
      knop.addEventListener("click", function (e) {
        e.preventDefault();
        vraagBetaallinkOp(true);
      });
    }
  }

  var poging = 0;
  function opnieuw(wachten) {
    if (poging >= TERUG_POGINGEN) {
      if (tekst) {
        tekst.innerHTML = "Wij hebben uw betaling nog niet binnen. Het kan zijn dat uw bank het nog verwerkt. Kies <em>Controleer nu</em> om het opnieuw te proberen. Is de betaling niet gelukt? Vraag dan <a href=\"#\" id=\"mollieOpnieuw\">een nieuwe betaallink</a> of mail ons uw betaalreferentie.";
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
    backendJsonp("status", "ref=" + encodeURIComponent(ref))
      .then(function (data) {
        var status = data && data.status ? String(data.status) : "";
        if (status === "paid" || status === "authorized") {
          if (tekst) {
            tekst.innerHTML = "Uw betaling van &euro;5 is ontvangen. Uw aanvraag voor een duplicaat is daarmee afgerond; u ontvangt de duplicaat zo snel mogelijk per post.";
          }
          var klaar = document.getElementById("terugStatusKnop");
          if (klaar) { klaar.hidden = true; klaar.style.display = "none"; }
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

function maakReferentie() {
  var t = new Date();
  var deel1 = t.getTime().toString(36).toUpperCase().slice(-6);
  var deel2 = Math.random().toString(36).toUpperCase().slice(2, 6);
  return "DUP-" + deel1 + "-" + deel2;
}

/* Elke aanvraag krijgt een eigen id, ook een 'nieuwe'. Het id gaat naar
   kolom P van het tabblad Aanvragen en wordt gebruikt om na te gaan of
   een aanvraag is aangekomen. Zo hoeft een aanvraag die alleen een traag
   antwoord opleverde niet dubbel in de wachtrij te komen. */
function maakAanvraagId() {
  var t = new Date();
  var deel1 = t.getTime().toString(36).toUpperCase().slice(-6);
  var deel2 = Math.random().toString(36).toUpperCase().slice(2, 6);
  return "AV-" + deel1 + "-" + deel2;
}

/* Staat er al een rij met dit id in de spreadsheet? Eén smalle lezing op
   de referentiekolom, dus snel. Twee pogingen omdat een gewoon
   verbindingsprobleem ook hier even op moet winnen. */
function controleerOfOntvangen(id, pogingen, timeoutMs) {
  if (!id) { return Promise.resolve(false); }
  /* Standaard drie pogingen, maar de aanroep na een mislukte
     verzending gebruikt er bewust maar één met een korte grens: deze
     controle is een versnelling, geen voorwaarde. De backend kijkt bij
     het opslaan zelf of de rij al bestaat, dus bij twijfel gewoon
     opnieuw versturen. Drie keer veertig seconden hier zou het totale
     wachten op de trage 404's van de webapp alleen maar oplopen. */
  var maxPogingen = (typeof pogingen === "number" && pogingen > 0) ? pogingen : 3;
  var limiet = timeoutMs || VERZEND_TIMEOUT_MS;
  function vraag(poging) {
    return backendJsonp("bekend", "ref=" + encodeURIComponent(id), limiet).then(function (antwoord) {
      return !!(antwoord && antwoord.gevonden);
    }).catch(function () {
      if (poging < maxPogingen - 1) {
        return wacht(1500).then(function () { return vraag(poging + 1); });
      }
      return false;
    });
  }
  return vraag(0);
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
  postNaarBackend({ type: "betaling-gemeld", betaalReferentie: laatsteRef })
    .then(function () {
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
function toonGeluktPagina(antwoord) {
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
    /* De QR-code en de handmatige betaalgegevens staan uit: de
       iDEAL-link is er nu in hetzelfde verzoek, en er is een knop om
       ze alsnog te tonen. Alleen als de link niet komt, gaan ze vanzelf
       open (zie vraagBetaallinkOp). */
    zetHandmatigBlok(false);
    toonBetaallink(antwoord);
  }
  if (sectie && sectie.scrollIntoView) { sectie.scrollIntoView(); }
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------
   Aanvraag opslaan in de backend (één aanvraag)
   ------------------------------------------------------------
   Dit gaat via JSONP (?act=aanvraag) en niet via fetch met POST.
   Reden, gemeten in een echte browser:
     fetch POST -> Google stuurt 302 -> browser maakt er een GET van
     -> doPost draait nooit -> het antwoord is de gewone
        "Backend aanvraag Autovergunning: actief."-tekst
     -> de aanvraag werd NIET weggeschreven terwijl het wel leek te
        slagen. Vandaar dat het af en toe "geen verbinding" heette.
   Een GET via een script-tag heeft dat probleem niet, en het antwoord
   is bovendien echt leesbaar zodat een fout meteen zichtbaar is.
   ------------------------------------------------------------ */

/* Tekst -> base64url, veilig om in een URL te zetten. */
function naarB64url(tekst) {
  var s = String(tekst || "");
  var bin;
  if (typeof TextEncoder !== "undefined") {
    var bytes = new TextEncoder().encode(s);
    bin = "";
    for (var i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
  } else {
    bin = unescape(encodeURIComponent(s));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function postNaarBackend(lichaam) {
  if (!BACKEND_URL) {
    return Promise.reject(new Error("BACKEND_URL_LEEG"));
  }
  return backendJsonp("aanvraag",
    "data=" + encodeURIComponent(naarB64url(JSON.stringify(lichaam))),
    VERZEND_TIMEOUT_MS
  ).then(function (antwoord) {
    /* Streng zijn: alleen een expliciet {ok:true} telt als geslaagd.
       Anders zou een onleesbaar of onverwacht antwoord ten onrechte
       als succes gelden en de betaalpagina tonen zonder dat er
       iets in de spreadsheet staat. */
    if (!antwoord || antwoord.ok !== true) {
      var reden = String((antwoord && antwoord.fout) || "onbekend antwoord van backend");
      throw new Error(reden);
    }
    return antwoord;
  });
}

function verstuurAanvraag(aanvraag) {
  /* postNaarBackend geeft al een object terug en gooit zelf een fout
     zodra het antwoord geen expliciet {ok:true} is.

     Gemeten: een verzoek naar de Apps Script-webapp faalt regelmatig
     met een 404 of een 404-achtig antwoord, ook al is de rij gewoon
     weggeschreven. Daarom meerdere pogingen. Dat is veilig, want de
     backend kijkt eerst of er al een rij met dit aanvraag-id bestaat
     en schrijft die dus niet nog een keer weg. */
  function poging(nummer) {
    return postNaarBackend(aanvraag).catch(function (fout) {
      if (nummer >= VERZEND_POGINGEN - 1) { throw fout; }
      /* Een 404 van de webapp komt meestal als de rij wél al is
         weggeschreven. Eén snelle kijk scheelt twee volledige rondes
         van twintig seconden of langer. Eén poging met een korte
         grens: als die controle zelf ook een 404 krijgt, is opnieuw
         versturen gewoon veilig — de backend houdt zelf bij of de rij
         al bestaat. */
      return controleerOfOntvangen(aanvraag.aanvraagId, 1, 20000).then(function (binnen) {
        if (binnen) { return { ok: true, alBinnen: true }; }
        return wacht(1200).then(function () {
          toonStatus("Verbinding mislukt, opnieuw proberen (" +
            (nummer + 2) + " van " + VERZEND_POGINGEN + ")...", "info");
          return poging(nummer + 1);
        });
      });
    });
  }
  return poging(0);
}

function wacht(ms) {
  return new Promise(function (klaar) { setTimeout(klaar, ms); });
}

/* ------------------------------------------------------------
   Wachtrij doorsturen (zoveel mogelijk)
   ------------------------------------------------------------ */
function verstuurWachtrij() {
  var rij = haalWachtrij();
  if (!rij.length) { return Promise.resolve(0); }
  var laatsteAntwoord = null;

  function weghalen(item) {
    var overig = haalWachtrij().filter(function (x) {
      return x.wachtrijId !== item.wachtrijId;
    });
    bewaarWachtrij(overig);
  }

  var beloften = rij.map(function (item) {
    return verstuurAanvraag(item).then(function (antwoord) {
      laatsteSoortAanvraag = item.soortAanvraag || "";
      laatsteRef = item.betaalReferentie || "";
      bewaarRef(laatsteRef);
      laatsteOvv = maakOvv(item);
      laatsteAntwoord = antwoord;
      weghalen(item);
      return 1;
    }).catch(function () {
      /* Ook hier geldt: het item kan toch zijn opgeslagen, want de
         verbinding kan bij het antwoord zijn gekapt. Kijk dat eerst na,
         anders komt dezelfde aanvraag alsnog dubbel in de sheet. */
      return controleerOfOntvangen(item.aanvraagId).then(function (binnen) {
        if (binnen) {
          laatsteSoortAanvraag = item.soortAanvraag || "";
          laatsteRef = item.betaalReferentie || "";
          bewaarRef(laatsteRef);
          laatsteOvv = maakOvv(item);
          laatsteAntwoord = laatsteAntwoord || {};
          weghalen(item);
          return 1;
        }
        return 0; /* niet gelukt, blijft in de wachtrij */
      });
    });
  });
  return Promise.all(beloften).then(function (resultaten) {
    var geslaagd = resultaten.reduce(function (a, b) { return a + b; }, 0);
    if (geslaagd > 0 && !haalWachtrij().length) {
      toonGeluktPagina(laatsteAntwoord);
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
  aanvraag.aanvraagId = maakAanvraagId();
  if (aanvraag.soortAanvraag === "duplicaat") {
    /* Bij een duplicaat is de referentie ook de betaalreferentie. */
    aanvraag.betaalReferentie = maakReferentie();
    aanvraag.aanvraagId = aanvraag.betaalReferentie;
    laatsteRef = aanvraag.betaalReferentie;
    bewaarRef(laatsteRef);
  } else {
    laatsteRef = "";
  }
  laatsteSoortAanvraag = aanvraag.soortAanvraag;
  laatsteOvv = maakOvv(aanvraag);
  /* De betaallink komt, als het meezit, in hetzelfde antwoord mee:
     één aanroep in plaats van twee. Zie act=aanvraag in de backend. */

  if (!BACKEND_URL) {
    aanvraag.wachtrijId = "av-" + Date.now() + "-" +
      Math.random().toString(36).slice(2, 8);
    bewaarWachtrij(haalWachtrij().concat([aanvraag]));
    toonStatus("Uw aanvraag is bewaard. Zodra de backend is ingesteld wordt hij automatisch verstuurd.", "info");
    return;
  }

  toonStatus("Aanvraag wordt verstuurd...", "info");
  verstuurAanvraag(aanvraag).then(function (antwoord) {
    try {
      toonGeluktPagina(antwoord);
      resetFormulier();
    } catch (err) {
      toonStatus("Uw aanvraag is verstuurd en is in goede orde ontvangen. De bevestigingspagina kon niet getoond worden; ververs de pagina.", "info");
    }
  }).catch(function (fout) {
    /* Geen verbinding betekent niet altijd dat de aanvraag kwijt is: het
       kan een traag antwoord op een verzoek zijn dat wél is verwerkt.
       Daarom eerst even navragen of de rij er staat. Pas als die er
       níet staat, wordt de aanvraag bewaard voor een nieuwe poging;
       anders zou dezelfde aanvraag twee keer in de sheet komen. */
    var tijdig = String((fout && fout.message) || "") === "timeout";
    var oorzaak = String((fout && fout.message) || "");
    toonStatus(tijdig
      ? "De verbinding met de backend is traag. Even wachten, wij controleren of uw aanvraag is binnen..."
      : "Geen verbinding met de backend. Even wachten, wij controleren of uw aanvraag is binnen...", "info");
    controleerOfOntvangen(aanvraag.aanvraagId).then(function (binnen) {
      if (binnen) {
        try {
          toonGeluktPagina({});
          resetFormulier();
        } catch (err) {
          toonStatus("Uw aanvraag is in goede orde ontvangen. De bevestigingspagina kon niet getoond worden; ververs de pagina.", "info");
        }
        return;
      }
      /* De backend gaf een echte fout terug. Die is nuttiger dan het
         misleidende "geen verbinding", dus die tonen we. */
      if (oorzaak && oorzaak !== "timeout") {
        console.error("Backendfout bij verzenden: " + oorzaak);
        aanvraag.wachtrijId = "av-" + Date.now() + "-" +
          Math.random().toString(36).slice(2, 8);
        bewaarWachtrij(haalWachtrij().concat([aanvraag]));
        toonStatus("Uw aanvraag is bewaard, maar kon niet worden verstuurd. Oorzaak: " +
          oorzaak + " Probeer het later opnieuw.", "fout");
        return;
      }
      aanvraag.wachtrijId = "av-" + Date.now() + "-" +
        Math.random().toString(36).slice(2, 8);
      bewaarWachtrij(haalWachtrij().concat([aanvraag]));
      toonStatus("Geen verbinding: uw aanvraag is opgeslagen en wordt automatisch verzonden zodra u weer online bent. U krijgt dan ook de bevestiging te zien.", "info");
    });
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
      } else if (soort === "mollielink") {
        waarde = laatsteMollieUrl || "";
        label = "Betaallink is gekopieerd.";
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
  if (handmatigKnop) {
    handmatigKnop.addEventListener("click", function () {
      var blok = document.getElementById("handmatigBlok");
      zetHandmatigBlok(!!blok && blok.hidden);
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