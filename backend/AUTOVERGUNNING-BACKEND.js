/* ============================================================
   BACKEND (webapp) - Aanvraag Autovergunning HSV De Ruisvoorn
   ------------------------------------------------------------
   ALGEMEEN: dit is het ene, schone bestand voor de backend.
   - Zet HET in het Apps Script-project dat gekoppeld zit aan de
     spreadsheet "Autovergunningen".
   - De web-app slaat uitsluitend aanvragen op in het tabblad
     "Aanvragen". Er wordt géén mail verstuurd vanuit dit project;
     dat kan optioneel via een apart timer-project (zie het
     opgave-jeugdviscursus-project voor hetzelfde patroon).

   HOE INSTALLEREN? (eenmalig, in 4 stappen)
   1. Maak op de Drive een spreadsheet aan en hernoem die naar
      "Autovergunningen".
   2. Open die sheet > Extensies > Apps Script > vervang ALLE
      code door DIT bestand > Ctrl+S.
   3. Implementeren > Nieuwe implementatie > Web-app >
      Uitvoeren als: Ik  |  Toegang: Iedereen > Implementeren.
   4. Kopieer de /exec-URL en zet die in aanvraag.js
      (BACKEND_URL).
   GEEN TRIGGER NODIG HIER: dit project verstuurt geen mail.
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
    json.duplicaatKostenAkkoord === true ? "ja" : "" /* O akkoord €5 duplicaat        */
  ]);

  opmaakToepassen(blad);

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------
   Opmaak van de sheet (handmatig draaien): ► verfraaiAanvragenSheet
   ------------------------------------------------------------ */
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

  var kop = blad.getRange(1, 1, 1, 15);
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
    var data = blad.getRange(2, 1, laatste - 1, 15);
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
  var kopRij = blad.getRange(1, 1, 1, 15).getValues()[0];
  var waarden = laatste >= 2 ? blad.getRange(2, 1, laatste - 1, 15).getValues() : [];
  var maxPerKolom = {
    1: 14,                                    /* A datum compact                   */
    2: 14,                                    /* B soort aanvraag compact          */
    8: 14,                                    /* H invalidenkaart compact          */
    14: 20,                                   /* N ingediend op compact            */
    15: 20                                    /* O akkoord €5 duplicaat compact    */
  };
  var limietNormaal = 45;
  var limietWrap = 30;
  for (var c = 0; c < 15; c++) {
    var kolom = c + 1;
    var langste = String(kopRij[c] || "").length;
    for (var r = 0; r < waarden.length; r++) {
      var regels = String(waarden[r][c] || "").split("\n");
      for (var z = 0; z < regels.length; z++) {
        if (regels[z].length > langste) langste = regels[z].length;
      }
    }
    var limiet = maxPerKolom[kolom] || (kolom === 4 || kolom === 5 || kolom === 9
                 ? limietWrap : limietNormaal);
    var tekens = Math.min(limiet, langste);
    blad.setColumnWidth(c + 1, Math.ceil(tekens * 8.5) + 12);
  }
}

/* Kleuren op de gegevensrijen zodat in één oogopslag duidelijk is
   wat de soort is en of er een invalidenkaart is:
   - B soort aanvraag: nieuw = lichtgroen, duplicaat = amber
   - H invalidenkaart: ja = lichtgroen, nee = lichtrood               */
function kleurSoortEnInvalide(blad, laatste) {
  var waarden = blad.getRange(2, 1, laatste - 1, 15).getValues();
  for (var i = 0; i < waarden.length; i++) {
    var rij = i + 2;
    var soort = String(waarden[i][1] || "").toLowerCase();    /* B */
    var invalide = String(waarden[i][7] || "").toLowerCase(); /* H */
    blad.getRange(rij, 2).setBackground(
      soort === "duplicaat" ? "#fff3cd" :
      soort === "nieuw"     ? "#e8f5e9" : "#ffffff");
    blad.getRange(rij, 8).setBackground(
      invalide === "ja" ? "#e8f5e9" :
      invalide === "nee" ? "#ffcdd2" : "#ffffff");
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

  if (nieuwGemaakt || blad.getLastRow() === 0) {
    var koppen = [
      "Datum aanvraag", "Soort aanvraag", "Voorletters", "Voornaam",
      "Achternaam", "Geboortedatum", "Vispasnummer", "Invalidenkaart",
      "Invalidenkaartnummer", "Akkoord voorwaarden",
      "Akkoord borg €25 sleutel", "Akkoord AVG",
      "Akkoord voorwaarden", "Ingediend op", "Akkoord €5 duplicaat"
    ];
    blad.getRange(1, 1, 1, koppen.length)
        .setValues([koppen])
        .setFontWeight("bold")
        .setBackground("#1b5e20")
        .setFontColor("#ffffff");
    opmaakToepassen(blad);
  }

  return { blad: blad, nieuwGemaakt: nieuwGemaakt };
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
function doGet() {
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