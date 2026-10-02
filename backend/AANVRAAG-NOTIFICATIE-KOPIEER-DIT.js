/* ============================================================
   AANVRAAG-NOTIFICATIE  -  autovergunning HSV De Ruisvoorn
   ------------------------------------------------------------
   DIT BESTAND HOORT IN EEN EIGEN PROJECT VAN HET GMAIL-ACCOUNT
   "deruisvoornhelden@gmail.com" (precies zoals de vangst- en
   opgave-meldingen).

   WAT HET DOET
   - Staat als timer (elke 5 minuten) in dat account.
   - Zoekt de spreadsheet "Autovergunningen" (jullie aanvragen-
     sheet) op naam op.
   - Stuurt voor elke nog niet gemelde rij een meldingsmail naar
     secretariaat@hsvderuisvoorn.nl met de gegevens en een link
     naar de sheet, en zet in kolom T ("Mail verstuurd") een
     "ja" zodra de mail is verzonden.

   ROBUUSTHEID (zelfde patroon als de opgave-timer)
   - LockService: voorkomt dat twee runs tegelijk draaien.
   - De hele run wordt bij een tijdelijke fout nog 2× opnieuw
     geprobeerd (4 seconden wachten) voordat er wordt gemeld.
   - Per rij wordt de mail met maximaal 3 pogingen verstuurd.
   - Elke fout wordt gelogd (Uitvoeringen) en in de sheet gezet;
     onverwerkte rijen worden bij de volgende run opnieuw geprobeerd.

   INSTALLEREN (eenmalig)
   1. Deel de spreadsheet "Autovergunningen" (jullie beheer-
      account) met deruisvoornhelden@gmail.com als BEWERKER.
   2. Log in als deruisvoornhelden@gmail.com.
   3. Ga naar https://script.google.com > Nieuw project > naam
      bijv. "AutovergunningMeldingen".
   4. Vervang alle code door DIT bestand > Ctrl+S.
   5. Klok-icoon > + Add Trigger > functie
      verstuurOnverzondenMails > Time-driven > Every 5 minutes.
   6. Toestemming geven (> Toestaan). Klaar.
   ============================================================ */

var MELDINGADRESSEN = [
  "secretariaat@hsvderuisvoorn.nl"
];

var SLUITLEUTEL = "verstuurOnverzondenAanvragen.lock";

function verstuurOnverzondenMails() {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(30000)) {
      Logger.log("Vorige run draaide nog - deze run overgeslagen");
      return;
    }
    voerUitMetRetry();
  } catch (e) {
    Logger.log("FATAAL: " + e.message);
    try { Logger.log(e.stack); } catch (negeren) {}
    throw e;
  } finally {
    try { lock.releaseLock(); } catch (negeren) {}
  }
}

/* Probeert de hele run tot 3× bij een fout aan het begin
   (bijv. tijdelijke Google-serverfout bij het openen van de
   sheet); pas daarna wordt de fout doorgegeven. */
function voerUitMetRetry() {
  var maxPogingen = 3;
  for (var p = 1; p <= maxPogingen; p++) {
    try {
      verwerkOnverzondenMails();
      return;
    } catch (fout) {
      if (p === maxPogingen) throw fout;
      Logger.log("Runpoging " + p + " mislukt (" + fout.message + ") - opnieuw proberen");
      Utilities.sleep(4000);
    }
  }
}

/* Kolomindeling tabblad "Aanvragen" (0-gebaseerd):
   0  A  datum aanvraag
   1  B  soort aanvraag (nieuw/duplicaat)
   2  C  voorletters
   3  D  voornaam
   4  E  achternaam
   5  F  geboortedatum
   6  G  vispasnummer
   7  H  invalidenkaart (ja/nee)
   8  I  invalidenkaartnummer
   9  J  akkoord voorwaarden (radio)
   10 K  borg €25 sleutel
   11 L  akkoord AVG
   12 M  akkoord voorwaarden (checkbox)
   13 N  ingediend op
   14 O  akkoord €5 duplicaat
   15 P  betaalreferentie
   16 Q  betaling gemeld
   17 R  betaling gemeld op
   18 S  betaald gecontroleerd
   19 T  mail verstuurd (deze kolom zet DIT project)            */

var MAILMARK_KOLOM = 19;   /* kolom T (20e) */

function verwerkOnverzondenMails() {
  var gevonden = vindBlad();
  var blad = gevonden.blad;
  var sheetUrl = "https://docs.google.com/spreadsheets/d/" +
                 gevonden.bestandId + "/edit";
  var data = blad.getDataRange().getValues();

  Logger.log("Start: " + data.length + " rijen, bestand " + gevonden.bestandId);

  if (blad.getLastColumn() < MAILMARK_KOLOM + 1) {
    blad.getRange(1, MAILMARK_KOLOM + 1).setValue("Mail verstuurd");
  }

  var verzonden = 0;
  var fouten = 0;

  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    if (String(r[MAILMARK_KOLOM]) === "ja") continue;   /* al gemailed */

    /* lege rijen overslaan */
    var gevuld = 0;
    for (var t = 0; t < 6; t++) {
      if (String(r[t] || "").length > 0) gevuld++;
    }
    if (gevuld === 0) continue;

    try {
      var tekst = bouwMeldingTekst(r, sheetUrl);
      var naam = String(r[4] || "").trim() || "aanvrager";
      var soort = String(r[1] || "").trim();
      var onderwerp = "Autovergunning " +
        (soort === "duplicaat" ? "duplicaat" : "aanvraag") + " ontvangen: " + naam;

      for (var a = 0; a < MELDINGADRESSEN.length; a++) {
        verzendMetRetry(MELDINGADRESSEN[a], onderwerp, tekst);
      }
      blad.getRange(i + 1, MAILMARK_KOLOM + 1).setValue("ja");
      verzonden++;
    } catch (fout) {
      fouten++;
      Logger.log("Rij " + (i + 1) + " mislukt: " + fout.message);
      blad.getRange(i + 1, MAILMARK_KOLOM + 1).setValue("FOUT: " + fout.message);
    }
  }

  Logger.log("Gereed: " + verzonden + " mails verzonden, " + fouten +
             " fouten, quota rest: " + MailApp.getRemainingDailyQuota());
}

/* Bouwt de meldingstekst op basis van één rij uit het tabblad. */
function bouwMeldingTekst(r, sheetUrl) {
  var soort = String(r[1] || "").trim();
  var displicaat = soort === "duplicaat";
  var naam = [r[2], r[3], r[4]].join(" ").replace(/\s+/g, " ").trim();

  var regels = [];
  regels.push("Er is een nieuwe aanvraag voor een Autovergunning binnengekomen.");
  regels.push("");
  regels.push("Datum aanvraag:  " + String(r[0] || ""));
  regels.push("Soort:           " + (displicaat ? "Duplicaat vergunning" : "Nieuwe vergunning"));
  regels.push("Naam:            " + naam);
  regels.push("Geboortedatum:   " + String(r[5] || ""));
  regels.push("Vispasnummer:    " + (String(r[6] || "").trim() || "-"));
  if (displicaat) {
    regels.push("Akkoord €5:      " + (String(r[14] || "").trim() === "ja" ? "akkoord" : "niet"));
    regels.push("Betaalreferentie:" + (String(r[15] || "").trim() || "-"));
    regels.push("Betaling gemeld: " + (String(r[16] || "").trim() === "ja" ? "ja (" + String(r[17] || "") + ")" : "nog niet"));
  } else {
    regels.push("Invalidenkaart:  " + (String(r[7] || "").trim() || "onbekend") +
                (String(r[8] || "").trim() ? " (" + String(r[8]) + ")" : ""));
    regels.push("Borg sleutel €25: " + (String(r[10] || "").trim() === "ja" ? "akkoord" : "niet"));
  }
  regels.push("Akkoord voorwaarden: " + (String(r[12] || "").trim() === "ja" ? "ja" : "nee"));
  regels.push("Ingediend op:    " + String(r[13] || ""));
  regels.push("");
  regels.push("Bekijk de aanvraag in het overzicht:");
  regels.push(sheetUrl);

  return regels.join("\n");
}

/* Stuurt een mail met maximaal 3 pogingen (opvangen van
   tijdelijke Google-serverfouten). */
function verzendMetRetry(naar, onderwerp, tekst) {
  var maxPogingen = 3;
  for (var p = 1; p <= maxPogingen; p++) {
    try {
      MailApp.sendEmail({ to: naar, subject: onderwerp, body: tekst });
      return;
    } catch (fout) {
      if (p === maxPogingen) throw fout;
      Logger.log("Mailpoging " + p + " mislukt voor " + naar + ": " + fout.message);
      Utilities.sleep(2000 * p);
    }
  }
}

/* ------------------------------------------------------------
   Vindt de spreadsheet "Autovergunningen" en het tabblad
   "Aanvragen" (maakt het tabblad indien nodig).
   ------------------------------------------------------------ */
function vindBlad() {
  var kandidaten = [];
  var it = DriveApp.getFilesByName("Autovergunningen");
  while (it.hasNext()) {
    var f = it.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) {
      kandidaten.push(f);
    }
  }
  if (kandidaten.length === 0) {
    throw new Error("spreadsheet 'Autovergunningen' niet gevonden " +
                    "(is hij gedeeld met dit account?)");
  }
  var bestand = SpreadsheetApp.openById(kandidaten[0].getId());
  var blad = bestand.getSheetByName("Aanvragen") ||
             bestand.insertSheet("Aanvragen");
  return { blad: blad, bestandId: kandidaten[0].getId() };
}