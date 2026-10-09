/* =============================================================
   Autovergunning — backend voor de eigen website (zonder sheet)
   HSV de Ruisvoorn Helden

   Deze web-app doet precies twee dingen:
     1. een meldingsmail sturen naar het secretariaat zodra er een
        aanvraag binnenkomt (nieuwe vergunning of duplicaat);
     2. bij een duplicaat een iDEAL-betaling van €5 regelen via Mollie
        en, zodra die geslaagd is, een betaalbevestiging sturen.

   Er wordt niets in een Google Sheet weggeschreven. Waar de backend
   iets moet onthouden (heb ik deze aanvraag al gemaild? welke
   payment-id hoort bij deze referentie?) gebruikt hij de
   script-eigenschappen van dit project: klein, permanent en zonder
   sheetrechten.

   Instellen (Bewerken → Projectinstellingen → Script-eigenschappen):
     MOLLIE_API_KEY   verplicht — testsleutel (test_...) of live-sleutel
     MELDING_ADRES    optioneel — anders secretariaat@hsvderuisvoorn.nl

   Implementeren: Implementaties beheren → nieuwe implementatie →
   web-app → Uitvoeren als: ikzelf, Toegang: iedereen. De /exec-URL
   die daarna verschijnt komt in BACKEND_URL van het htm-bestand.
   ============================================================= */

var MOLLIE_BETAAL_URL = "https://api.mollie.com/v2/payments";
var DUPLICAAT_BEDRAG = "5.00";
var STANDAARD_MELDING = "secretariaat@hsvderuisvoorn.nl";
var SITE_VERSIE = "site-1";

/* ------------------------------------------------------------
   Instellingen
   ------------------------------------------------------------ */
function eigenschap(naam, standaard) {
  try {
    var waarde = PropertiesService.getScriptProperties().getProperty(naam);
    waarde = waarde === null || waarde === undefined ? "" : String(waarde).trim();
    return waarde || standaard;
  } catch (fout) {
    return standaard;
  }
}

function meldAdres() {
  var adres = eigenschap("MELDING_ADRES", STANDAARD_MELDING);
  if (adres === "nee" || adres === "no" || adres === "false") { return ""; }
  return adres;
}

function mollieSleutel() {
  return eigenschap("MOLLIE_API_KEY", "");
}

function mollieSleutelSoort() {
  var sleutel = mollieSleutel();
  if (!sleutel) { return "geen"; }
  if (sleutel.indexOf("test_") === 0) { return "test"; }
  if (sleutel.indexOf("live_") === 0) { return "live"; }
  return "onbekend";
}

/* ------------------------------------------------------------
   Onthouden zonder sheet: script-eigenschappen als klein geheugen
   ------------------------------------------------------------ */
function lees(naam) {
  try {
    return PropertiesService.getScriptProperties().getProperty(naam) || "";
  } catch (fout) {
    return "";
  }
}

function zet(naam, waarde) {
  try {
    PropertiesService.getScriptProperties().setProperty(naam, String(waarde));
    return true;
  } catch (fout) {
    return false;
  }
}

function leesObject(naam) {
  var tekst = lees(naam);
  if (!tekst) { return null; }
  try {
    var obj = JSON.parse(tekst);
    return obj && typeof obj === "object" ? obj : null;
  } catch (fout) {
    return null;
  }
}

function zetObject(naam, obj) {
  return zet(naam, JSON.stringify(obj));
}

/* ------------------------------------------------------------
   Routering
   ------------------------------------------------------------ */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var act = String(p.act || "ping").toLowerCase();
  var cb = p.callback || p.cb || "";
  if (act === "webhook") {
    /* Mollie belt deze URL (ook als GET); het antwoord maakt niet
       uit, alleen of de betaling verwerkt wordt. */
    try { verwerkWebhook(p.id || ""); } catch (fout) { /* stil */ }
    return tekstOutput("OK");
  }
  var antwoord;
  try {
    antwoord = voerUit(act, p);
  } catch (fout) {
    antwoord = { fout: String((fout && fout.message) || fout) };
  }
  return jsonpAntwoord(cb, antwoord);
}

function doPost(e) {
  var p = (e && e.parameter) || {};
  var id = String(p.id || "").trim();
  if (!id && e && e.postData && e.postData.contents) {
    var velden = Utilities.parseQueryString(String(e.postData.contents));
    id = String(velden["id"] || "").trim();
  }
  try { verwerkWebhook(id); } catch (fout) { /* stil */ }
  return tekstOutput("OK");
}

function voerUit(act, p) {
  if (act === "ping") { return geefPing(); }
  if (act === "aanvraag") { return verwerkAanvraag(p.data, p.terug); }
  if (act === "betaallink") { return geefBetaallink(p.ref, p.nieuw === "1" || p.nieuw === "true"); }
  if (act === "status") { return geefStatus(p.ref, p.id); }
  if (act === "gekend") { return { gekend: !!lees("aanvraag:" + String(p.ref || "").trim()) }; }
  if (act === "webhook") { return verwerkWebhook(p.id || ""); }
  return { fout: "onbekende act: " + act };
}

function geefPing() {
  return {
    ok: true,
    versie: SITE_VERSIE,
    sleutel: mollieSleutelSoort(),
    melding: meldAdres(),
    sheet: false
  };
}

/* ------------------------------------------------------------
   Aanvraag binnen: mail sturen, en bij een duplicaat de betaling
   ------------------------------------------------------------ */
function verwerkAanvraag(data, terugUrl) {
  var gelezen = leesAanvraagUitData(data);
  if (gelezen.fout) { return { fout: gelezen.fout }; }
  var a = gelezen.aanvraag;

  var soort = String(a.soortAanvraag || "").trim().toLowerCase();
  if (soort !== "nieuw" && soort !== "duplicaat") {
    return { fout: "soort aanvraag ontbreekt" };
  }
  var achternaam = trimTekst(a.achternaam);
  if (!achternaam) { return { fout: "naam van de aanvrager ontbreekt" }; }
  var email = trimTekst(a.emailAdres);
  if (!geldigeEpostaam(email)) { return { fout: "geldig e-mailadres ontbreekt" }; }

  var ref = trimTekst(a.betaalReferentie) || trimTekst(a.aanvraagId) || maakRef(soort);
  var id = trimTekst(a.aanvraagId) || ref;

  /* Bij een herstelpoging van de website komt dezelfde aanvraag nog
     een keer binnen. Niet opnieuw mailen en geen tweede betaling
     maken: de opgeslagen reactie gaat dan gewoon mee terug. */
  var alBinnen = leesObject("aanvraag:" + id) || {};
  var mailOk = true;
  if (!alBinnen.mailGedaan) {
    mailOk = stuurAanvraagMail(a, ref, soort);
    if (mailOk) {
      zetObject("aanvraag:" + id, {
        mailGedaan: true,
        referentie: ref,
        soort: soort,
        voornaam: trimTekst(a.voornaam),
        achternaam: achternaam,
        naam: trimTekst(a.voornaam + " " + achternaam),
        email: email,
        vispasnummer: trimTekst(a.vispasnummer),
        toegevoegd: nuTekst()
      });
    }
  }

  var antwoord = {
    ok: true,
    soort: soort,
    referentie: ref,
    aanvraagId: id,
    mailOk: mailOk
  };

  if (soort === "duplicaat") {
    var betaling = betaallinkVoorRef(ref, {
      voornaam: trimTekst(a.voornaam),
      achternaam: achternaam,
      naam: trimTekst(a.voornaam + " " + achternaam),
      email: email,
      vispasnummer: trimTekst(a.vispasnummer)
    }, terugUrl, false);
    if (betaling && betaling.url) {
      antwoord.betaallink = betaling.url;
      antwoord.paymentId = betaling.paymentId;
      if (betaling.betaald) { antwoord.betaald = true; }
    } else {
      antwoord.fout = String((betaling && betaling.fout) || "de betaling kon niet worden aangemaakt");
    }
  }
  return antwoord;
}

/* ------------------------------------------------------------
   Mollie
   ------------------------------------------------------------ */

/* De betaallink die bij een referentie hoort. Bestaat er een betaling
   die nog open staat, dan wordt die hergebruikt; anders (of met
   forceer=true) komt er een nieuwe. */
function betaallinkVoorRef(ref, aanvrager, terugUrl, forceerNieuw) {
  var sleutel = mollieSleutel();
  if (!sleutel) {
    return { fout: "er is geen Mollie-sleutel ingesteld (script-eigenschap MOLLIE_API_KEY)" };
  }
  var opgeslagen = leesObject("bet:" + ref);
  if (!forceerNieuw && opgeslagen && opgeslagen.paymentId) {
    var huidig = mollieBetaling(opgeslagen.paymentId);
    var status = huidig ? String(huidig.status || "") : "";
    if (status === "open" || status === "pending") {
      return {
        paymentId: opgeslagen.paymentId,
        url: String((huidig._links && huidig._links.checkout && huidig._links.checkout.href) || opgeslagen.url || ""),
        status: status
      };
    }
    if (status === "paid" || status === "authorized") {
      return {
        paymentId: opgeslagen.paymentId,
        url: String(opgeslagen.url || ""),
        status: status,
        betaald: true
      };
    }
  }

  var bron = aanvrager;
  if (!bron) {
    var bekend = leesObject("aanvraag:" + ref) || {};
    bron = {
      voornaam: bekend.voornaam || "",
      achternaam: bekend.achternaam || "",
      naam: bekend.naam || "",
      email: bekend.email || "",
      vispasnummer: bekend.vispasnummer || ""
    };
  }
  return maakMollieBetaling(ref, bron, terugUrl);
}

function maakMollieBetaling(ref, aanvrager, terugUrl) {
  var sleutel = mollieSleutel();
  if (!sleutel) {
    return { fout: "er is geen Mollie-sleutel ingesteld (script-eigenschap MOLLIE_API_KEY)" };
  }
  var naam = trimTekst(aanvrager.naam || (aanvrager.voornaam + " " + aanvrager.achternaam));
  var body = {
    amount: { currency: "EUR", value: DUPLICAAT_BEDRAG },
    description: ("Duplicaat Autovergunning " + naam + " " + ref).slice(0, 140),
    method: "ideal",
    locale: "nl_NL",
    metadata: {
      referentie: String(ref || ""),
      voornaam: String(aanvrager.voornaam || ""),
      achternaam: String(aanvrager.achternaam || ""),
      email: String(aanvrager.email || ""),
      vispasnummer: String(aanvrager.vispasnummer || "")
    }
  };
  var terug = geldigeTerugUrl(terugUrl);
  if (terug) { body.redirectUrl = terug + "?betaald=1"; }
  var hook = eigenWebhookUrl();
  if (hook) { body.webhookUrl = hook; }

  var res;
  try {
    res = UrlFetchApp.fetch(MOLLIE_BETAAL_URL, {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + sleutel },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (fout) {
    return { fout: "geen verbinding met Mollie: " + String(fout) };
  }
  var code = res.getResponseCode();
  var tekst = res.getContentText();
  if (code >= 400) {
    return { fout: "Mollie gaf fout " + code + ": " + String(tekst).slice(0, 200) };
  }
  var data;
  try { data = JSON.parse(tekst); } catch (fout) { data = null; }
  var checkout = data && data._links && data._links.checkout ? String(data._links.checkout.href || "") : "";
  if (!data || !data.id || !checkout) {
    return { fout: "onverwacht antwoord van Mollie: " + String(tekst).slice(0, 200) };
  }
  var betaling = {
    paymentId: String(data.id),
    url: checkout,
    status: String(data.status || "open"),
    referentie: String(ref || "")
  };
  zetObject("bet:" + ref, betaling);
  return betaling;
}

function mollieBetaling(paymentId) {
  var sleutel = mollieSleutel();
  if (!sleutel || !paymentId) { return null; }
  var res;
  try {
    res = UrlFetchApp.fetch(MOLLIE_BETAAL_URL + "/" + encodeURIComponent(String(paymentId)), {
      method: "get",
      headers: { Authorization: "Bearer " + sleutel },
      muteHttpExceptions: true
    });
  } catch (fout) {
    return null;
  }
  if (res.getResponseCode() >= 400) { return null; }
  try { return JSON.parse(res.getContentText()); } catch (fout) { return null; }
}

function eigenWebhookUrl() {
  try {
    var url = String(ScriptApp.getService().getUrl() || "");
    return url ? url + "?act=webhook" : "";
  } catch (fout) {
    return "";
  }
}

function geldigeTerugUrl(url) {
  var s = trimTekst(url);
  /* Alleen een echt adres; Mollie stuurt de aanvrager hier naartoe na
     de betaling. Vraagparameters en ankers gaan eraf, de pagina hangt
     er zelf ?betaald=1 aan vast. */
  if (!/^https?:\/\//i.test(s)) { return ""; }
  return s.replace(/[?#].*$/, "");
}

/* ------------------------------------------------------------
   Webhook en status: de betaling binnenhalen en melden
   ------------------------------------------------------------ */
function verwerkWebhook(id) {
  var paymentId = trimTekst(id);
  if (!paymentId) { return { fout: "geen betaling-id ontvangen" }; }
  var betaaling = mollieBetaling(paymentId);
  if (!betaaling) { return { fout: "betaling niet gevonden bij Mollie" }; }
  var status = String(betaaling.status || "");
  if (status === "paid" || status === "authorized") {
    stuurBetaalbevestiging(paymentId, betaaling);
  }
  return { status: status };
}

function geefStatus(ref, id) {
  var sleutelRef = trimTekst(ref);
  var paymentId = trimTekst(id);
  if (!paymentId && sleutelRef) {
    var opgeslagen = leesObject("bet:" + sleutelRef);
    paymentId = opgeslagen ? String(opgeslagen.paymentId || "") : "";
  }
  if (!paymentId) { return { status: "", referentie: sleutelRef }; }
  var betaaling = mollieBetaling(paymentId);
  if (!betaaling) { return { status: "", referentie: sleutelRef }; }
  var status = String(betaaling.status || "");
  if (status === "paid" || status === "authorized") {
    stuurBetaalbevestiging(paymentId, betaaling);
  }
  return { status: status, referentie: sleutelRef || metadataWaarde(betaaling, "referentie") };
}

function metadataWaarde(betaaling, naam) {
  var meta = (betaaling && betaaling.metadata) || {};
  return String(meta[naam] || "");
}

/* Eén betaalbevestiging per betaling, ook als de webhook en de
   statuscontrole van de website tegelijk binnenkomen. Het merkje wordt
   vóór het versturen gezet; lukt versturen niet, dan gaat het merkje
   eraf zodat er alsnog een poging volgt. */
function stuurBetaalbevestiging(paymentId, betaaling) {
  var merk = "betaalmeld:" + paymentId;
  if (lees(merk)) { return false; }
  var betaling = betaaling || mollieBetaling(paymentId);
  if (!betaling) { return false; }
  var status = String(betaling.status || "");
  if (status !== "paid" && status !== "authorized") { return false; }
  var adres = meldAdres();
  if (!adres) { return false; }

  zet(merk, "bezig");
  try {
    var ref = metadataWaarde(betaling, "referentie");
    var naam = trimTekst(metadataWaarde(betaling, "voornaam") + " " + metadataWaarde(betaling, "achternaam"));
    var bedrag = betaling.amount && betaling.amount.value ? String(betaling.amount.value) : DUPLICAAT_BEDRAG;
    var betaaldOp = String(betaling.paidAt || betaling.createdAt || "");
    var onderwerp = "Betaling geslaagd (€" + bedragVerwijderPunt(bedrag) + ") — duplicaat autovergunning" +
      (naam ? " " + naam : "") + (ref ? " (" + ref + ")" : "");
    var regels = [
      "De betaling voor de duplicaat Autovergunning is voltooid.",
      "",
      "Referentie: " + (ref || "—"),
      "Naam: " + (naam || "—"),
      "E-mailadres aanvrager: " + (metadataWaarde(betaling, "email") || "—"),
      "Vispasnummer: " + (metadataWaarde(betaling, "vispasnummer") || "—"),
      "Bedrag: €" + bedragVerwijderPunt(bedrag),
      "Betaald op: " + (betaaldOp || "—"),
      "Mollie betaling-id: " + paymentId,
      "Status: " + status,
      "",
      "De duplicaatvergunning kan worden opgestuurd."
    ];
    var rijen = [
      ["Referentie", ref],
      ["Naam", naam],
      ["E-mailadres", metadataWaarde(betaling, "email")],
      ["Vispasnummer", metadataWaarde(betaling, "vispasnummer")],
      ["Bedrag", "€" + bedragVerwijderPunt(bedrag)],
      ["Betaald op", betaaldOp],
      ["Mollie betaling-id", paymentId],
      ["Status", status]
    ];
    MailApp.sendEmail({
      to: adres,
      subject: onderwerp,
      body: regels.join("\n"),
      htmlBody: mailHtml("Betaling geslaagd", "De betaling voor de duplicaat Autovergunning is voltooid. De duplicaatvergunning kan worden opgestuurd.", rijen),
      name: "Autovergunning HSV de Ruisvoorn"
    });
    zet(merk, "ja");
    return true;
  } catch (fout) {
    weg(merk);
    return false;
  }
}

function stuurAanvraagMail(a, ref, soort) {
  var adres = meldAdres();
  if (!adres) { return false; }
  var naam = trimTekst(a.voornaam + " " + a.achternaam);
  var duplicaat = soort === "duplicaat";
  var onderwerp = (duplicaat ? "Aanvraag duplicaat autovergunning" : "Nieuwe aanvraag autovergunning") +
    " — " + naam + " (" + ref + ")";
  var intro = duplicaat
    ? "Er is een aanvraag voor een duplicaat Autovergunning binnengekomen. De €5 wordt via iDEAL betaald; volgt hieronder de betaalstatus."
    : "Er is een aanvraag voor een nieuwe Autovergunning binnengekomen.";
  var invalide = String(a.invalidenkaart || "").trim();
  if (invalide === "ja" && trimTekst(a.invalidenkaartNummer)) {
    invalide = "ja, nummer " + trimTekst(a.invalidenkaartNummer);
  }
  var rijen = [
    ["Soort aanvraag", duplicaat ? "Duplicaat vergunning" : "Nieuwe vergunning"],
    ["Referentie", ref],
    ["Datum aanvraag", trimTekst(a.datumAanvraag)],
    ["Naam", trimTekst(a.voorletters + " " + a.voornaam + " " + a.achternaam)],
    ["Geboortedatum", trimTekst(a.geboortedatum)],
    ["Vispasnummer", trimTekst(a.vispasnummer)],
    ["E-mailadres", trimTekst(a.emailAdres)],
    ["Invalidenkaart", duplicaat ? "niet van toepassing" : (invalide || "—")]
  ];
  if (duplicaat) {
    var refDuplicaat = ref;
    rijen.push(["Betaalstatus", "nog niet voltooid — volgt zodra de betaling binnen is"]);
    rijen.push(["Betaalreferentie", refDuplicaat]);
  } else {
    rijen.push(["Akkoord €25 borg", a.borgAkkoord ? "ja" : "nee"]);
  }
  rijen.push(["Akkoord AVG", a.avgAkkoord ? "ja" : "nee"]);
  rijen.push(["Akkoord voorwaarden", a.voorwaardenCheckbox ? "ja" : "nee"]);
  rijen.push(["Ontvangen op", nuTekst()]);

  var tekst = [intro, ""].concat(
    rijen.map(function (rij) { return rij[0] + ": " + (rij[1] || "—"); })
  ).concat(["", "Deze mail is automatisch verstuurd door het aanvraagformulier op de website."]).join("\n");

  try {
    MailApp.sendEmail({
      to: adres,
      subject: onderwerp,
      body: tekst,
      htmlBody: mailHtml(onderwerp, intro, rijen),
      name: "Autovergunning HSV de Ruisvoorn"
    });
    return true;
  } catch (fout) {
    return false;
  }
}

function mailHtml(kop, intro, rijen) {
  var html = "<div style=\"font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#0F0F0F;line-height:1.5\">" +
    "<div style=\"background:#124f76;color:#ffffff;padding:12px 16px;border-radius:6px 6px 0 0\">" +
    "<strong style=\"font-size:16px\">" + esc(kop) + "</strong><br><span style=\"font-size:13px\">HSV de Ruisvoorn Helden</span></div>" +
    "<div style=\"border:1px solid #d9e2e9;border-top:0;padding:16px;border-radius:0 0 6px 6px\">" +
    "<p style=\"margin:0 0 14px\">" + esc(intro) + "</p>" +
    "<table style=\"border-collapse:collapse;width:100%;max-width:560px;font-size:14px\">";
  for (var i = 0; i < rijen.length; i++) {
    var naam = rijen[i][0];
    var waarde = rijen[i][1] === undefined || rijen[i][1] === null || rijen[i][1] === "" ? "—" : rijen[i][1];
    html += "<tr>" +
      "<td style=\"padding:6px 10px 6px 0;color:#4a5b66;vertical-align:top;white-space:nowrap\">" + esc(naam) + "</td>" +
      "<td style=\"padding:6px 0;font-weight:bold\">" + esc(String(waarde)) + "</td></tr>";
  }
  html += "</table></div></div>";
  return html;
}

/* ------------------------------------------------------------
   Hulpjes
   ------------------------------------------------------------ */
function geefBetaallink(ref, forceerNieuw) {
  var sleutelRef = trimTekst(ref);
  if (!sleutelRef) { return { fout: "geen referentie meegegeven" }; }
  var betaling = betaallinkVoorRef(sleutelRef, null, "", !!forceerNieuw);
  if (betaling && betaling.url) {
    return {
      ok: true,
      referentie: sleutelRef,
      betaallink: betaling.url,
      paymentId: betaling.paymentId,
      status: betaling.status || ""
    };
  }
  return { fout: String((betaling && betaling.fout) || "geen betaallink beschikbaar") };
}

function trimTekst(s) {
  return String(s === null || s === undefined ? "" : s).replace(/^\s+|\s+$/g, "");
}

function geldigeEpostaam(adres) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(adres || ""));
}

function bedragVerwijderPunt(bedrag) {
  var s = String(bedrag || DUPLICAAT_BEDRAG).replace(/\.00$/, "");
  return s;
}

function nuTekst() {
  var d = new Date();
  return pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear() +
    " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function pad(n) { return n < 10 ? "0" + n : String(n); }

function maakRef(soort) {
  var t = new Date();
  var deel1 = t.getTime().toString(36).toUpperCase().slice(-6);
  var deel2 = Math.random().toString(36).toUpperCase().slice(2, 6);
  return (soort === "duplicaat" ? "DUP-" : "AV-") + deel1 + "-" + deel2;
}

function esc(tekst) {
  return String(tekst === null || tekst === undefined ? "" : tekst)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function tekstOutput(tekst) {
  return ContentService.createTextOutput(String(tekst))
    .setMimeType(ContentService.MimeType.TEXT);
}

/* JSONP-antwoord: de website leest het via een script-tag, omdat een
   POST vanuit een browser door de redirect van Apps Script in een GET
   verandert (daarom ook hier alles via GET). */
function jsonpAntwoord(callback, obj) {
  var naam = String(callback || "cb").replace(/[^A-Za-z0-9_.]/g, "");
  if (!naam || naam.charAt(0) === "." || /^[0-9]/.test(naam)) { naam = "cb"; }
  return ContentService.createTextOutput(naam + "(" + JSON.stringify(obj) + ");")
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

/* base64url -> JSON. Zelf gedecodeerd (Utilities.base64Decode weigert
   hier zonder meer), zodat een kapotte parameter een echte reden
   teruggeeft in plaats van "aanvraag onleesbaar". */
function leesAanvraagUitData(data) {
  var s = String(data || "").trim();
  if (!s) { return { fout: "geen aanvraag ontvangen" }; }
  var bytes = b64urlNaarBytes(s);
  if (!bytes) { return { fout: "aanvraag is geen base64" }; }
  var tekst = bytesNaarUtf8(bytes);
  var aanvraag;
  try {
    aanvraag = JSON.parse(tekst);
  } catch (fout) {
    return { fout: "aanvraag is geen geldige JSON (begin: " + String(tekst).slice(0, 60) + ")" };
  }
  if (!aanvraag || typeof aanvraag !== "object") {
    return { fout: "aanvraag bevat geen gegevens" };
  }
  return { aanvraag: aanvraag };
}

function b64urlNaarBytes(tekst) {
  var alfabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var s = String(tekst || "").replace(/-/g, "+").replace(/_/g, "/");
  var bytes = [];
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    if (c === "=") { break; }
    var waarde = alfabet.indexOf(c);
    if (waarde < 0) { return null; }
    buffer = (buffer << 6) | waarde;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  return bytes;
}

function bytesNaarUtf8(bytes) {
  var s = "";
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i++] & 255;
    if (b < 0x80) {
      s += String.fromCharCode(b);
    } else if (b < 0xE0) {
      s += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F));
    } else if (b < 0xF0) {
      var c2 = bytes[i++] & 0x3F;
      var c3 = bytes[i++] & 0x3F;
      s += String.fromCharCode(((b & 0x0F) << 12) | (c2 << 6) | c3);
    } else {
      var e2 = bytes[i++] & 0x3F;
      var e3 = bytes[i++] & 0x3F;
      var e4 = bytes[i++] & 0x3F;
      s += String.fromCharCode(((b & 0x07) << 18) | (e2 << 12) | (e3 << 6) | e4);
    }
  }
  return s;
}
