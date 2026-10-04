/* ============================================================
   BACKEND (webapp) - Aanvraag Autovergunning HSV De Ruisvoorn
   ------------------------------------------------------------
   ALGEMEEN: dit is het ene, schone bestand voor de backend.
   - Zet HET in het Apps Script-project dat gekoppeld zit aan de
     spreadsheet "Autovergunningen".
   - De web-app slaat uitsluitend aanvragen op in het tabblad
     "Aanvragen". Mails over nieuwe aanvragen worden NIET vanuit
     dit project verstuurd, maar vanuit het aparte account
     deruisvoornhelden@gmail.com via AANVRAAG-NOTIFICATIE.js
     (net als de meldingen van vangsten en opgaven).

   HOE INSTALLEREN? (eenmalig, in 5 stappen)
   1. Maak op de Drive een spreadsheet aan en hernoem die naar
      "Autovergunningen".
   2. Open die sheet > Extensies > Apps Script > vervang ALLE
      code door DIT bestand > Ctrl+S.
   3. Zet de API-sleutel van Mollie erbij:
      Projectinstellingen > Script-eigenschappen > Toevoegen:
        naam   MOLLIE_API_KEY
        waarde test_... (of live_...)
   4. Implementeren > Nieuwe implementatie > Web-app >
      Uitvoeren als: Ik  |  Toegang: Iedereen > Implementeren.
   5. Kopieer de /exec-URL en zet die in aanvraag.js
      (BACKEND_URL).
   GEEN TRIGGER NODIG HIER: dit project verstuurt geen mail.

   BETALEN MET iDEAL (Mollie) is optioneel: zonder MOLLIE_API_KEY
   werkt alleen de QR-code en het handmatig overmaken. Het tabblad
   "Betalingen" wordt aangemaakt zodra er een betaallink nodig is.
   ------------------------------------------------------------ */

/* ------------------------------------------------------------
   Ontvangt het formulier en zet de aanvraag als rij in de
   spreadsheet (tabblad "Aanvragen").
   ------------------------------------------------------------ */
function doPost(e) {
  var json = {};
  try {
    if (e && e.postData && e.postData.contents) {
      json = JSON.parse(e.postData.contents);
    }
  } catch (fout) {
    json = {};
  }

  /* een apart verzoeksoort: aanvrager meldt dat de betaling is gedaan */
  if (json.type === "betaling-gemeld") {
    return verwerkBetaalMelding(json);
  }

  /* Mollie webhook: POST van Mollie zelf (id=tr_...&status=paid) */
  if (e && e.postData && e.postData.contents &&
      String(e.postData.contents).indexOf("id=") >= 0) {
    verwerkMollieWebhook(String(e.postData.contents));
    return ContentService.createTextOutput("ok")
      .setMimeType(ContentService.MimeType.TEXT);
  }

  var blad = koppelSpreadsheet().blad;
  blad.appendRow([
    naarDagMaandJaar(json.datumAanvraag),          /* A datum aanvraag (dd-mm-jjjj)  */
    json.soortAanvraag      || "",                 /* B soort aanvraag (nieuw/duplicaat) */
    json.voorletters        || "",                 /* C voorletters                  */
    json.voornaam           || "",                 /* D voornaam                     */
    json.achternaam         || "",                 /* E achternaam                    */
    nlDatum(json.geboortedatum),                /* F geboortedatum (dd-mm-jjjj)    */
    json.vispasnummer       || "",                 /* G vispasnummer                  */
    json.invalidenkaart     || "",                 /* H invalidenkaart (ja/nee)       */
    json.invalidenkaartNummer || "",               /* I invalidenkaartnummer          */
    json.voorwaardenRadio   === "ja" ? "ja" : "",  /* J akkoord voorwaarden (radio)   */
    json.borgAkkoord        === true ? "ja" : "",  /* K akkoord borg €25 sleutel      */
    json.avgAkkoord         === true ? "ja" : "",  /* L akkoord AVG                    */
    json.voorwaardenCheckbox === true ? "ja" : "", /* M akkoord voorwaarden (checkbox)*/
    vandaagTekst(),                                 /* N ingediend op (dd-mm-jjjj hh:mm) */
    json.duplicaatKostenAkkoord === true ? "ja" : "", /* O akkoord €5 duplicaat        */
    json.betaalReferentie   || "",                 /* P betaalreferentie (alleen duplicaat) */
    "",                                             /* Q betaling gemeld (via knop)    */
    "",                                             /* R betaling gemeld op (tijdstip) */
    ""                                              /* S betaald gecontroleerd (penningmeester) */
  ]);

  opmaakToepassen(blad);

  /* bij een duplicaat meteen een iDEAL-betaallink (Mollie) maken,
     zodat de aanvrager na verzenden direct kan betalen */
  var betaallink = "";
  var betaalFout = "";
  if (isDuplicaat(json)) {
    var betaal = haalOfMaakBetaallink(json.betaalReferentie, false);
    betaallink = betaal && betaal.url ? betaal.url : "";
    if (!betaallink && betaal) {
      betaalFout = String(betaal.fout || "");
    }
  }

  return ContentService.createTextOutput(
    JSON.stringify({ ok: true, betaallink: betaallink, fout: betaalFout }))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------
   Aanvrager meldt 'ik heb betaald' (duplicaat, via QR-code).
   Zoekt de rij aan de hand van de betaalreferentie (kolom P) en
   zet 'ja' + tijdstip in kolommen Q en R.
   ------------------------------------------------------------ */
function verwerkBetaalMelding(json) {
  var blad = koppelSpreadsheet().blad;
  var ref = String(json.betaalReferentie || "").trim();
  if (!ref) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, reden: "geen-referentie" }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var gevonden = markeerBetalingGemeld(blad, ref);
  return ContentService.createTextOutput(JSON.stringify({ ok: gevonden, gevonden: gevonden }))
    .setMimeType(ContentService.MimeType.JSON);
}

/* Zet 'ja' + tijdstip (kolommen Q en R) in de rij met deze
   betaalreferentie (kolom P). Geeft terug of de rij gevonden is. */
function markeerBetalingGemeld(blad, ref) {
  var laatste = blad.getLastRow();
  if (laatste >= 2) {
    var waarden = blad.getRange(2, 1, laatste - 1, 19).getValues();
    for (var i = 0; i < waarden.length; i++) {
      if (String(waarden[i][15] || "").trim() === ref) {
        var rij = i + 2;
        blad.getRange(rij, 17).setValue("ja");
        blad.getRange(rij, 18).setValue(vandaagTekst());
        kleurSoortEnInvalide(blad, laatste);
        return true;
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------
   BETALEN MET iDEAL (Mollie)
   ------------------------------------------------------------
   De API-sleutel staat NIET in dit bestand, maar in de
   script-eigenschap "MOLLIE_API_KEY"
   (Projectinstellingen > Script-eigenschappen > Toevoegen).
   Zo staat de sleutel niet in GitHub en niet in de browser.

   Wat er gebeurt bij een duplicaat-aanvraag:
   1. de backend maakt een Mollie-order aan (€5) en schrijft de
      checkout-link in het tabblad "Betalingen";
   2. de aanvrager krijgt op de bedanktpagina een grote
      "Betaal €5 met iDEAL"-knop;
   3. Mollie stuurt na het betalen de status naar deze webapp
      (webhook) en zet 'Betaling gemeld' in het tabblad "Aanvragen".
   ------------------------------------------------------------ */
var MOLLIE_BETAAL_URL = "https://api.mollie.com/v2/payments";
var BETALINGEN_TAB = "Betalingen";
var DUPLICAAT_BEDRAG_MOLLIE = "5.00";

function mollieApiSleutel() {
  try {
    return String(PropertiesService.getScriptProperties()
      .getProperty("MOLLIE_API_KEY") || "").trim();
  } catch (fout) {
    return "";
  }
}

function isDuplicaat(json) {
  return String((json && json.soortAanvraag) || "").trim().toLowerCase() === "duplicaat";
}

function koppelBetalingenTabblad() {
  var bestand = koppelSpreadsheet().bestand;
  var blad = bestand.getSheetByName(BETALINGEN_TAB);
  if (!blad) {
    blad = bestand.insertSheet(BETALINGEN_TAB);
    blad.getRange(1, 1, 1, 6).setValues([[
      "Betaalreferentie", "Mollie payment-id", "Betaallink",
      "Status", "Aangemaakt", "Betaald op"
    ]]).setFontWeight("bold")
       .setBackground("#1b5e20")
       .setFontColor("#ffffff");
    blad.setFrozenRows(1);
  }
  return blad;
}

/* Laatste betaalregel met deze referentie (of null). */
function zoekBetaling(ref) {
  var gezocht = String(ref || "").trim();
  if (!gezocht) { return null; }
  var blad = koppelBetalingenTabblad();
  var laatste = blad.getLastRow();
  if (laatste < 2) { return null; }
  var waarden = blad.getRange(2, 1, laatste - 1, 6).getValues();
  for (var i = waarden.length - 1; i >= 0; i--) {
    if (String(waarden[i][0] || "").trim() === gezocht) {
      return {
        rij: i + 2,
        paymentId: String(waarden[i][1] || ""),
        url: String(waarden[i][2] || ""),
        status: String(waarden[i][3] || "")
      };
    }
  }
  return null;
}

/* Status waarmee de link nog gebruikt kan worden. */
function statusNogBruikbaar(status) {
  var s = String(status || "").trim().toLowerCase();
  return s === "" || s === "open" || s === "pending" ||
         s === "paid" || s === "authorized";
}

function schrijfBetaling(ref, paymentId, url, status) {
  var blad = koppelBetalingenTabblad();
  var bestaand = zoekBetaling(ref);
  var rij = bestaand ? bestaand.rij : blad.getLastRow() + 1;
  blad.getRange(rij, 1, 1, 6).setValues([[
    String(ref || ""),
    String(paymentId || ""),
    String(url || ""),
    String(status || ""),
    vandaagTekst(),
    status === "paid" ? vandaagTekst() : ""
  ]]);
  return rij;
}

function mollieTerugUrl() {
  var vast = "";
  try {
    vast = String(PropertiesService.getScriptProperties()
      .getProperty("MOLLIE_REDIRECT_URL") || "").trim();
  } catch (fout) {
    vast = "";
  }
  if (vast) { return vast; }
  return "https://hsvderuisvoorn.github.io/autovergunning/aanvraag.html?betaald=1";
}

function mollieWebhookUrl() {
  try {
    var url = String(ScriptApp.getService().getUrl() || "");
    return url ? url + "?act=webhook" : "";
  } catch (fout) {
    return "";
  }
}

/* Naam van de aanvrager opzoeken bij een betaalreferentie. */
function zoekAanvraag(ref) {
  var gezocht = String(ref || "").trim();
  if (!gezocht) { return null; }
  var blad = koppelSpreadsheet().blad;
  var laatste = blad.getLastRow();
  if (laatste < 2) { return null; }
  var waarden = blad.getRange(2, 1, laatste - 1, 16).getValues();
  for (var i = waarden.length - 1; i >= 0; i--) {
    if (String(waarden[i][15] || "").trim() === gezocht) {
      return {
        voornaam: String(waarden[i][3] || ""),
        achternaam: String(waarden[i][4] || "")
      };
    }
  }
  return null;
}

/* Maakt een Mollie-payment aan. Geeft null terug bij fouten of als er
   geen API-sleutel is ingesteld (de QR-/handmatige betaling blijft
   dan gewoon werken).
   Let op: een Mollie-betaallink is ongeveer 15 minuten geldig. Daarom
   kan de aanvrager op de bedanktpagina ook een nieuwe link opvragen. */
function maakMollieBetaling(ref, voornaam, achternaam) {
  var sleutel = mollieApiSleutel();
  if (!sleutel) { return null; }
  var body = {
    amount: { currency: "EUR", value: DUPLICAAT_BEDRAG_MOLLIE },
    description: ("Duplicaat Autovergunning " + String(ref || "")).slice(0, 140),
    redirectUrl: mollieTerugUrl(),
    locale: "nl_NL",
    metadata: {
      betaalReferentie: String(ref || ""),
      voornaam: String(voornaam || ""),
      achternaam: String(achternaam || "")
    }
  };
  var hook = mollieWebhookUrl();
  if (hook) { body.webhookUrl = hook; }
  var res = UrlFetchApp.fetch(MOLLIE_BETAAL_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + sleutel },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 400) {
    throw new Error("Mollie " + res.getResponseCode() + ": " +
      String(res.getContentText()).substring(0, 200));
  }
  var data = JSON.parse(res.getContentText());
  var checkout = "";
  if (data) {
    var links = data._links || data.links || {};
    checkout = String(links.checkout || "");
  }
  if (!data || !data.id || !checkout) {
    throw new Error("onverwacht antwoord van Mollie: " +
      String(res.getContentText()).substring(0, 200));
  }
  return {
    paymentId: String(data.id),
    url: checkout,
    status: String(data.status || "open")
  };
}

/* Bestaande (niet-verlopen) link hergebruiken, anders een nieuwe
   maken. Met nieuw=true wordt altijd een verse link gemaakt. */
function haalOfMaakBetaallink(ref, nieuw) {
  try {
    var gezocht = String(ref || "").trim();
    if (!gezocht) { return null; }
    var bestaand = zoekBetaling(gezocht);
    if (!nieuw && bestaand && bestaand.url && statusNogBruikbaar(bestaand.status)) {
      return bestaand;
    }
    var aanvraag = zoekAanvraag(gezocht);
    var nieuwBetaling = maakMollieBetaling(gezocht,
      aanvraag ? aanvraag.voornaam : "",
      aanvraag ? aanvraag.achternaam : "");
    if (!nieuwBetaling) { return null; }
    schrijfBetaling(gezocht, nieuwBetaling.paymentId, nieuwBetaling.url,
      nieuwBetaling.status);
    return {
      rij: 0,
      paymentId: nieuwBetaling.paymentId,
      url: nieuwBetaling.url,
      status: nieuwBetaling.status
    };
  } catch (fout) {
    return { rij: 0, url: "", status: "fout", fout: String(fout) };
  }
}

/* Webhook van Mollie: payment-id + status. Zet bij 'paid' ook
   'Betaling gemeld' in het tabblad "Aanvragen". */
function verwerkMollieWebhook(inhoud) {
  var velden = Utilities.parseQueryString(String(inhoud || ""));
  var id = String(velden["id"] || "").trim();
  var status = String(velden["status"] || "").trim().toLowerCase();
  if (!id) { return false; }
  var blad = koppelBetalingenTabblad();
  var laatste = blad.getLastRow();
  if (laatste < 2) { return false; }
  var ids = blad.getRange(2, 2, laatste - 1, 3).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || "").trim() === id) {
      var rij = i + 2;
      blad.getRange(rij, 4).setValue(status || "onbekend");
      if (status === "paid") {
        blad.getRange(rij, 6).setValue(vandaagTekst());
        markeerBetalingGemeld(koppelSpreadsheet().blad,
          String(ids[i][1] || "").trim());
      }
      return true;
    }
  }
  return false;
}

/* JSONP-antwoord: de aanvraagpagina leest het antwoord via een
   script-tag, omdat de Apps Script-webapp geen CORS-headers zet. */
function jsonpAntwoord(callback, obj) {
  var naam = String(callback || "cb").replace(/[^A-Za-z0-9_.]/g, "");
  if (!naam || naam.charAt(0) === "." || /^[0-9]/.test(naam)) { naam = "cb"; }
  return ContentService.createTextOutput(naam + "(" + JSON.stringify(obj) + ");")
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}
function verfraaiAanvragenSheet() {
  var blad = koppelSpreadsheet().blad;
  opmaakToepassen(blad);
}

/* Zet consistente opmaak op de hele sheet: groene/witte koptekst,
   eerste rij bevroren, randen en kolombreedtes die zich aan de
   tekst aanpassen. Kan gerust vaker draaien. */
function opmaakToepassen(blad) {
  blad.setRowHeight(1, 24);
  blad.setFrozenRows(1);

  var kop = blad.getRange(1, 1, 1, 19);
  kop.setFontWeight("bold")
     .setBackground("#1b5e20")
     .setFontColor("#ffffff")
     .setFontFamily("Arial")
     .setFontSize(10)
     .setHorizontalAlignment("center")
     .setVerticalAlignment("middle")
     .setBorder(true, true, true, true, true, true,
                "#cfd8dc", SpreadsheetApp.BorderStyle.SOLID);

  var laatste = blad.getLastRow();
  if (laatste >= 2) {
    var data = blad.getRange(2, 1, laatste - 1, 19);
    data.setFontFamily("Arial")
        .setFontSize(10)
        .setVerticalAlignment("middle")
        .setBorder(true, true, true, true, true, true,
                   "#e0e0e0", SpreadsheetApp.BorderStyle.SOLID);
    for (var k = 0; k < [4, 5, 9].length; k++) {
      blad.getRange(2, [4, 5, 9][k], laatste - 1, 1).setWrap(true);
    }
    fitKolombreedtes(blad, laatste);
    kleurSoortEnInvalide(blad, laatste);
  } else {
    fitKolombreedtes(blad, 1);
  }
}

/* Pas kolombreedtes aan de langste tekst in elke kolom aan (kop
   rij en alle rijen eronder). */
function fitKolombreedtes(blad, laatste) {
  if (laatste < 1) laatste = 1;
  var kopRij = blad.getRange(1, 1, 1, 19).getValues()[0];
  var waarden = laatste >= 2 ? blad.getRange(2, 1, laatste - 1, 19).getValues() : [];
  var maxPerKolom = {
    1: 14,                                    /* A datum compact                   */
    2: 14,                                    /* B soort aanvraag compact          */
    6: 12,                                    /* F geboortedatum compact           */
    8: 14,                                    /* H invalidenkaart compact          */
    14: 20,                                   /* N ingediend op compact            */
    15: 20,                                   /* O akkoord €5 duplicaat compact    */
    16: 18,                                   /* P betaalreferentie compact        */
    17: 14,                                   /* Q betaling gemeld compact         */
    18: 20,                                   /* R betaling gemeld op compact      */
    19: 20                                    /* S betaald gecontroleerd compact   */
  };
  var limietNormaal = 45;
  var limietWrap = 30;
  for (var c = 0; c < 19; c++) {
    var kolom = c + 1;
    var langste = String(kopRij[c] || "").length;
    for (var r = 0; r < waarden.length; r++) {
      var celWaarde = waarden[r][c];
      if (celWaarde instanceof Date) {
        /* datafomaten zijn geen teksten: meet alleen de datumkluis */
        celWaarde = Utilities.formatDate(
          celWaarde, Session.getScriptTimeZone(), "dd-MM-yyyy");
      }
      var regels = String(celWaarde || "").split("\n");
      for (var z = 0; z < regels.length; z++) {
        if (regels[z].length > langste) langste = regels[z].length;
      }
    }
    var limiet = maxPerKolom[kolom] || (kolom === 4 || kolom === 5 || kolom === 9
                 ? limietWrap : limietNormaal);
    /* zodat een datumkolom nooit te breed wordt ondanks de kop */
    if (kolom === 6 && langste > 12) langste = 12;
    var tekens = Math.min(limiet, langste);
    blad.setColumnWidth(c + 1, Math.ceil(tekens * 8.5) + 12);
  }
}

/* Kleuren op de gegevensrijen zodat in één oogopslag duidelijk is
   wat de soort is en of er een invalidenkaart is:
   - B soort aanvraag: nieuw = lichtgroen, duplicaat = amber
   - H invalidenkaart: ja = lichtgroen, nee = lichtrood               */
function kleurSoortEnInvalide(blad, laatste) {
  var waarden = blad.getRange(2, 1, laatste - 1, 19).getValues();
  for (var i = 0; i < waarden.length; i++) {
    var rij = i + 2;
    var soort = String(waarden[i][1] || "").toLowerCase();    /* B */
    var invalide = String(waarden[i][7] || "").toLowerCase(); /* H */
    var gemeld = String(waarden[i][16] || "").toLowerCase();  /* Q */
    var gecontroleerd = String(waarden[i][18] || "").toLowerCase(); /* S */
    blad.getRange(rij, 2).setBackground(
      soort === "duplicaat" ? "#fff3cd" :
      soort === "nieuw"     ? "#e8f5e9" : "#ffffff");
    blad.getRange(rij, 8).setBackground(
      invalide === "ja" ? "#e8f5e9" :
      invalide === "nee" ? "#ffcdd2" : "#ffffff");
    blad.getRange(rij, 17).setBackground(
      gemeld === "ja" ? "#dcedc8" : "#ffffff");
    blad.getRange(rij, 19).setBackground(
      gecontroleerd === "ja" ? "#a5d6a7" : "#ffffff");
  }
}

/* ------------------------------------------------------------
   Koppelt een spreadsheet en gebruikt (of maakt) het tabblad
   "Aanvragen" met kolomkoppen.
   ------------------------------------------------------------ */
function koppelSpreadsheet() {
  var bestand;
  try {
    bestand = SpreadsheetApp.getActiveSpreadsheet();
  } catch (fout) {
    bestand = null;
  }

  if (!bestand) {
    bestand = SpreadsheetApp.create("Autovergunningen");
    verplaatsNaarMap(bestand, "Autovergunningen");
  }

  var blad = bestand.getSheetByName("Aanvragen");
  var nieuwGemaakt = false;

  if (!blad) {
    blad = bestand.insertSheet("Aanvragen");
    nieuwGemaakt = true;
  }

  var koppen = [
    "Datum aanvraag", "Soort aanvraag", "Voorletters", "Voornaam",
    "Achternaam", "Geboortedatum", "Vispasnummer", "Invalidenkaart",
    "Invalidenkaartnummer", "Akkoord voorwaarden",
    "Akkoord borg €25 sleutel", "Akkoord AVG",
    "Akkoord voorwaarden", "Ingediend op", "Akkoord €5 duplicaat",
    "Betaalreferentie", "Betaling gemeld", "Betaling gemeld op",
    "Betaald gecontroleerd"
  ];

  if (nieuwGemaakt || blad.getLastRow() === 0) {
    blad.getRange(1, 1, 1, koppen.length)
        .setValues([koppen])
        .setFontWeight("bold")
        .setBackground("#1b5e20")
        .setFontColor("#ffffff");
    opmaakToepassen(blad);
  } else if (blad.getLastColumn() < koppen.length) {
    /* bestaande sheet: ontbrekende kopkolommen aanvullen zodat de
       nieuwe kolommen (referentie/gemeld/gecontroleerd e.d.) ook
       een naam hebben */
    var vanaf = blad.getLastColumn() + 1;
    blad.getRange(1, vanaf, 1, koppen.length - vanaf + 1)
        .setValues([koppen.slice(vanaf - 1)])
        .setFontWeight("bold")
        .setBackground("#1b5e20")
        .setFontColor("#ffffff");
    opmaakToepassen(blad);
  }

  return { bestand: bestand, blad: blad, nieuwGemaakt: nieuwGemaakt };
}

/* ------------------------------------------------------------
   Maakt het tabblad "Aanvragen" in één klik schoon: alle oude
   (test)rijen eruit en de koppen + opmaak opnieuw neerzetten.
   Loopt u als function in de Apps Script-editor.
   ------------------------------------------------------------ */
function resetAanvragenTab() {
  var koppel = koppelSpreadsheet();
  koppel.blad.clear();
  /* na clear is het tabblad leeg: koppen + opmaak opnieuw */
  koppelSpreadsheet();
  return "Tabblad 'Aanvragen' is leeggemaakt en opnieuw opgebouwd.";
}

/* ------------------------------------------------------------
   Past uitsluitend de opmaak en kolombreedtes aan (zonder iets
   te wissen) en kleurt de bestaande rijen opnieuw. Handig na
   een backend-update zodat de sheet in één klik netjes wordt.
   ------------------------------------------------------------ */
function verfraaiAanvragenSheet() {
  var koppel = koppelSpreadsheet();
  opmaakToepassen(koppel.blad);
  return "Opmaak en kolombreedtes zijn vernieuwd.";
}

/* ------------------------------------------------------------
   Zet een nieuwe spreadsheet in de opgegeven map op de Drive.
   ------------------------------------------------------------ */
function verplaatsNaarMap(bestand, mapNaam) {
  var gids = DriveApp.getFileById(bestand.getId());
  var zoeker = DriveApp.getFoldersByName(mapNaam);
  if (!zoeker.hasNext()) {
    DriveApp.createFolder(mapNaam);
    zoeker = DriveApp.getFoldersByName(mapNaam);
  }
  gids.moveTo(zoeker.next());
}

/* ------------------------------------------------------------
   Bevestigingspagina als iemand de /exec-URL in een browser
   opent (geen formulier, alleen "backend actief").
   ------------------------------------------------------------ */
function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var act = String(params["act"] || "").trim().toLowerCase();

  /* aanvrager vraagt de actuele iDEAL-betaallink op */
  if (act === "betaallink") {
    var ref = String(params["ref"] || "").trim();
    var nieuw = String(params["nieuw"] || "") === "1";
    var betaal = haalOfMaakBetaallink(ref, nieuw);
    if (betaal && betaal.url) {
      return jsonpAntwoord(params["callback"], {
        ok: true,
        url: betaal.url,
        status: betaal.status || "",
        nieuw: nieuw
      });
    }
    return jsonpAntwoord(params["callback"], {
      ok: false,
      fout: betaal ? String(betaal.fout || "geen betaallink") : "geen betaallink"
    });
  }

  /* aanvrager controleert (na terugkomst van Mollie) de status */
  if (act === "status") {
    var gezocht = zoekBetaling(String(params["ref"] || "").trim());
    return jsonpAntwoord(params["callback"], gezocht
      ? { ok: true, status: gezocht.status }
      : { ok: false });
  }

  return ContentService.createTextOutput("Backend aanvraag Autovergunning: actief.")
    .setMimeType(ContentService.MimeType.TEXT);
}

/* ------------------------------------------------------------
   Zet "jjjj-mm-dd" (of ISO-datum/-tijdstip) om naar "dd-mm-jjjj".
   ------------------------------------------------------------ */
function nlDatum(waarde) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(waarde || "").trim());
  if (!m) return waarde || "";
  return m[3] + "-" + m[2] + "-" + m[1];
}

/* ------------------------------------------------------------
   Zet een datum (Date of tekenreeks) om naar "dd-mm-jjjj" in de
   tijdzone van het project.
   ------------------------------------------------------------ */
function naarDagMaandJaar(waarde) {
  if (waarde instanceof Date && !isNaN(waarde.getTime())) {
    return Utilities.formatDate(waarde, Session.getScriptTimeZone(), "dd-MM-yyyy");
  }
  return nlDatum(waarde);
}

/* ------------------------------------------------------------
   Nu, als "dd-mm-jjjj uu:mm" in de tijdzone van het project.
   ------------------------------------------------------------ */
function vandaagTekst() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd-MM-yyyy HH:mm");
}