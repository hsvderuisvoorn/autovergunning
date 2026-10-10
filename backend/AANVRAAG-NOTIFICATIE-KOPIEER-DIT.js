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

   DEZE TIMER IS (BIJNA) OVERBODIG: de backend (AUTOVERGUNNING-
   KOPIEER-DIT) verstuurt de melding al direct op het moment dat de
   aanvraag binnenkomt en zet dan zelf kolom T op "ja". Deze timer
   haalt zo alleen nog de rijen op waarvan die eerste mail is
   mislukt. Installeer hem dus gerust als vangnet; dubbele mails
   kunnen niet ontstaan.

   ROBUUSTHEID (zelfde patroon als de opgave-timer)
   - LockService: voorkomt dat twee runs tegelijk draaien.
   - De hele run wordt bij een tijdelijke fout nog 1Ã— opnieuw
     geprobeerd (4 seconden wachten) voordat er wordt gemeld.
   - Per rij wordt de mail met maximaal 2 pogingen verstuurd.
   - Elke fout komt in kolom T te staan als "FOUT x/3: reden".
     Na 3 pogingen wordt die rij niet meer geprobeerd: een rij die
     blijft falen zou anders elke 5 minuten opnieuw een mail
     proberen te sturen, het dagquota van Gmail leegtrekken en elke
     run als mislukt laten eindigen.
   - Is het dagquota van MailApp op, dan stopt de run netjes in plaats
     van te blijven proberen; de resterende rijen gaan mee naar de
     volgende run.
   - Een afgebroken run is geen mislukte run: de reden staat in het
     log. Alleen echte programmeerfouten zouden hier nog naar voren
     moeten komen.

   BELANGRIJK: het Gmail-account heeft een limiet van 100 mails per
   dag, gedeeld met de andere timers op dat account (vangsten,
   opgaven). Blijft daar een mail hangen, dan raakt het hele account
   zijn limiet en krijgt ook deze script geen mail meer doorgestuurd.
   Zie daarom de kolom T na bij een fout.

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

/* Hoe vaak een rij mag falen voordat hij wordt opgegeven. Zonder deze
   grens blijft een blijvend falende rij elke 5 minuten opnieuw een
   mail sturen, waardoor het dagquota van Gmail leegloopt. */
var MAX_POGINGEN_PER_RIJ = 3;
var MAILMARK_KOP = "Mail verstuurd";
var TIMER_FUNCTIE = "verstuurOnverzondenMails";
var TIMER_ELKE_MINUTEN = 5;

/* ------------------------------------------------------------
   Zet de timer aan die elke TIMER_ELKE_MINUTEN minuten kijkt of er
   nog een ongemelde aanvraag is.

   Waarom dit los staat: een tijdgestuurde trigger is geen code maar
   een losse klok die Apps Script in het project bewaart. Wordt het
   project gekopieerd, verplaatst of opgeschoond, dan verdwijnt die
   klok en blijft het script zelf gewoon werken als je het zelf
   aanroept. Er stond geen code om die klok te maken, waardoor er
   stilletjes geen mail meer kon binnenkomen zonder dat er ergens een
   fout zichtbaar werd.

   Voer deze functie Ã©Ã©n keer uit na het plakken van het script.
   Daarna draait de timer vanzelf. Tweede keer uitvoeren is
   onschadelijk: dan zegt het script alleen dat de timer er al is.
   ------------------------------------------------------------ */
function maakTimer() {
  var bestaande = ScriptApp.getProjectTriggers();
  var aantal = 0;
  for (var i = 0; i < bestaande.length; i++) {
    if (bestaande[i].getHandlerFunction() === TIMER_FUNCTIE) { aantal++; }
  }
  if (aantal > 0) {
    Logger.log("De timer staat er al (" + aantal + "x). Er is niets toegevoegd.");
    return;
  }
  ScriptApp.newTrigger(TIMER_FUNCTIE).timeBased()
    .everyMinutes(TIMER_ELKE_MINUTEN).create();
  Logger.log("Timer aangemaakt: " + TIMER_FUNCTIE + " elke " +
    TIMER_ELKE_MINUTEN + " minuten.");
}

function verstuurOnverzondenMails() {
  var lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(30000)) {
      Logger.log("Vorige run draaide nog - deze run overgeslagen");
      return;
    }
    var r = voerUitMetRetry();
    Logger.log("Klaar: " + r.verzonden + " verzonden, " + r.fouten +
               " fouten, " + r.overgeslagen + " overgeslagen, " +
               "quotaMail: " + MailApp.getRemainingDailyQuota());
  } catch (e) {
    /* Bewust niet opnieuwgooien: de run is dan wel afgebroken, maar
       een mislukte uitvoering zegt niets als het om een bekende situatie
       gaat zoals een opgegeven rij of een vol dagquota. De reden
       staat in het log hierboven. */
    Logger.log("LET OP - run niet afgerond: " + e.message);
    try { Logger.log(String(e.stack || "")); } catch (negeren) {}
  } finally {
    try { lock.releaseLock(); } catch (negeren) {}
  }
}

/* Probeert de hele run nog 1Ã— bij een tijdelijke fout (bijv. een
   Google-serverfout bij het openen van de sheet). Bij een fout die
   blijvend is (quota, geen toegang, ongeldig adres) is opnieuw
   proberen zinloos en wordt meteen teruggegeven. */
function voerUitMetRetry() {
  var maxPogingen = 2;
  for (var p = 1; p <= maxPogingen; p++) {
    try {
      return verwerkOnverzondenMails();
    } catch (fout) {
      if (p === maxPogingen || isBlijvendeFout(fout)) {
        Logger.log("Run afgebroken: " + fout.message);
        return { verzonden: 0, fouten: 0, overgeslagen: 0 };
      }
      Logger.log("Runpoging " + p + " mislukt (" + fout.message + ") - opnieuw proberen");
      Utilities.sleep(4000);
    }
  }
  return { verzonden: 0, fouten: 0, overgeslagen: 0 };
}

function isBlijvendeFout(fout) {
  var m = String((fout && fout.message) || "");
  return /quota|invalid recipient|not authorized|permission|toegang|unauthorized/i.test(m);
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
   10 K  borg â‚¬25 sleutel
   11 L  akkoord AVG
   12 M  akkoord voorwaarden (checkbox)
   13 N  ingediend op
   14 O  akkoord â‚¬5 duplicaat
   15 P  betaalreferentie
   16 Q  betaling gemeld
   17 R  betaling gemeld op
   18 S  betaald gecontroleerd
   19 T  mail verstuurd (merkkolom: de backend zet hier "ja" als zijn
         meldingsmail gelukt is; DIT project zet hem als vangnet)
   20 U  e-mailadres van de aanvrager (backend; hier niet gebruikt)  */

var MAILMARK_KOLOM = 19;   /* kolom T (20e) */

/* Hoe vaak is deze rij al geprobeerd? Kolom T bevat "FOUT 2/3: ..." */
function telPogingen(mark) {
  var m = /(\d+)\s*\/\s*\d+/.exec(String(mark || ""));
  return m ? parseInt(m[1], 10) : 0;
}

/* Is deze rij opgegeven na te veel pogingen? */
function isOpgegeven(mark) {
  var tekst = String(mark || "").trim();
  if (tekst.slice(0, 4).toUpperCase() !== "FOUT") { return false; }
  return telPogingen(tekst) >= MAX_POGINGEN_PER_RIJ;
}

function verwerkOnverzondenMails() {
  var gevonden = vindBlad();
  var blad = gevonden.blad;
  var sheetUrl = "https://docs.google.com/spreadsheets/d/" +
                 gevonden.bestandId + "/edit";

  if (blad.getLastColumn() < MAILMARK_KOLOM + 1) {
    blad.getRange(1, MAILMARK_KOLOM + 1).setValue(MAILMARK_KOP);
  }

  var data = blad.getDataRange().getValues();
  Logger.log("Start: " + data.length + " rijen, bestand " + gevonden.bestandId);

  var verzonden = 0;
  var fouten = 0;
  var overgeslagen = 0;

  for (var i = 1; i < data.length; i++) {
    var r = data[i];
    var mark = String(r[MAILMARK_KOLOM] || "").trim();
    if (mark === "ja") { continue; }              /* al gemailed */

    /* lege rijen overslaan */
    var gevuld = 0;
    for (var t = 0; t < 6; t++) {
      if (String(r[t] || "").length > 0) { gevuld++; }
    }
    if (gevuld === 0) { continue; }

    /* Blijvend falende rij: niet meer proberen. */
    if (isOpgegeven(mark)) {
      overgeslagen++;
      Logger.log("Rij " + (i + 1) + " overgeslagen (al " +
                 MAX_POGINGEN_PER_RIJ + " pogingen mislukt): " + mark);
      continue;
    }

    /* Dagquota op? Stoppen in plaats van verder te branden: elke
       poging kost dan een plek die er niet meer is. */
    if (MailApp.getRemainingDailyQuota() <= 0) {
      Logger.log("Dagquota van MailApp op. Resterende rijen worden " +
                 "bij een volgende run geprobeerd.");
      return { verzonden: verzonden, fouten: fouten, overgeslagen: overgeslagen };
    }

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
      var poging = telPogingen(mark) + 1;
      blad.getRange(i + 1, MAILMARK_KOLOM + 1).setValue(
        "FOUT " + poging + "/" + MAX_POGINGEN_PER_RIJ + ": " + fout.message);
      Logger.log("Rij " + (i + 1) + " mislukt (poging " + poging + "/" +
                 MAX_POGINGEN_PER_RIJ + "): " + fout.message);
    }
  }

  return { verzonden: verzonden, fouten: fouten, overgeslagen: overgeslagen };
}

/* ------------------------------------------------------------
   ZELFTEST (Ã©Ã©n klik in de editor): controleert of de juiste
   spreadsheet wordt gevonden, telt de nog te mailen rijen en
   stuurt een testmail. Het resultaat zie je in het log.
   ------------------------------------------------------------ */
function testInstellingen() {
  var uit = [];
  var gevonden = vindBlad();
  var blad = gevonden.blad;
  uit.push("Bestand gevonden: " + gevonden.bestandId);
  uit.push("Titel:            " + blad.getParent().getName());
  uit.push("Tabblad:          " + blad.getName());
  uit.push("Rijen (incl. kop): " + blad.getLastRow());

  if (blad.getLastColumn() < MAILMARK_KOLOM + 1) {
    blad.getRange(1, MAILMARK_KOLOM + 1).setValue(MAILMARK_KOP);
    uit.push("Kop '" + MAILMARK_KOP + "' toegevoegd in kolom T.");
  } else {
    uit.push("Kop '" + MAILMARK_KOP + "' aanwezig in kolom T.");
  }

  var data = blad.getDataRange().getValues();
  var teMailen = 0;
  var opgegeven = 0;
  for (var i = 1; i < data.length; i++) {
    var mark = String(data[i][MAILMARK_KOLOM] || "").trim();
    if (mark === "ja") { continue; }
    var gevuld = 0;
    for (var t = 0; t < 6; t++) {
      if (String(data[i][t] || "").length > 0) { gevuld++; }
    }
    if (gevuld === 0) { continue; }
    if (isOpgegeven(mark)) {
      opgegeven++;
      continue;
    }
    teMailen++;
  }
  uit.push("Nog te mailen rijen:    " + teMailen);
  uit.push("Opgegeven (3x fout):    " + opgegeven +
           "   <-- deze blijven staan; wis kolom T om ze opnieuw te proberen");
  uit.push("Resterend mailquota:    " + MailApp.getRemainingDailyQuota() +
           " van 100 per dag, gedeeld met de andere timers op dit account");

  var log = uit.join("\n");
  Logger.log(log);
  /* Bij een vol dagquota zou de zelftest zelf op een fout stuiten en
     dan niets tonen. */
  if (MailApp.getRemainingDailyQuota() > 0) {
    MailApp.sendEmail(MELDINGADRESSEN[0], "Zelftest autovergunning-notificatie", log);
  } else {
    Logger.log("Zelftest: geen testmail verstuurd, dagquota is op.");
  }
  return log;
}

/* Bouwt de meldingstekst op basis van Ã©Ã©n rij uit het tabblad. */
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
    regels.push("Akkoord â‚¬5:      " + (String(r[14] || "").trim() === "ja" ? "akkoord" : "niet"));
    regels.push("Betaalreferentie:" + (String(r[15] || "").trim() || "-"));
    regels.push("Betaling gemeld: " + (String(r[16] || "").trim() === "ja" ? "ja (" + String(r[17] || "") + ")" : "nog niet"));
  } else {
    regels.push("Invalidenkaart:  " + (String(r[7] || "").trim() || "onbekend") +
                (String(r[8] || "").trim() ? " (" + String(r[8]) + ")" : ""));
    regels.push("Borg sleutel â‚¬25: " + (String(r[10] || "").trim() === "ja" ? "akkoord" : "niet"));
  }
  regels.push("Akkoord voorwaarden: " + (String(r[12] || "").trim() === "ja" ? "ja" : "nee"));
  regels.push("Ingediend op:    " + String(r[13] || ""));
  regels.push("");
  regels.push("Bekijk de aanvraag in het overzicht:");
  regels.push(sheetUrl);

  return regels.join("\n");
}

/* Stuurt een mail met maximaal 2 pogingen (opvangen van tijdelijke
   Google-serverfouten). Bij een blijvende fout (quota, ongeldig
   adres) meteen stoppen: extra pogingen maken het probleem niet
   goed en kosten alleen quota. */
function verzendMetRetry(naar, onderwerp, tekst) {
  var maxPogingen = 2;
  for (var p = 1; p <= maxPogingen; p++) {
    try {
      MailApp.sendEmail({ to: naar, subject: onderwerp, body: tekst });
      return;
    } catch (fout) {
      if (p === maxPogingen || isBlijvendeFout(fout)) { throw fout; }
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
    throw new Error("spreadsheet 'Autovergunningen' niet gevonden - " +
                    "is de sheet gedeeld met dit account (Bewerker) en " +
                    "heet hij precies 'Autovergunningen'?");
  }
  Logger.log("Kandidaten gevonden: " + kandidaten.length);

  /* kies het bestand met het juiste tabblad 'Aanvragen' inclusief
     de kop 'Betaalreferentie' (kolom P), zodat we nooit in een
     dummy-bestand terechtkomen */
  for (var i = 0; i < kandidaten.length; i++) {
    var bestand;
    try {
      bestand = SpreadsheetApp.openById(kandidaten[i].getId());
    } catch (fout) {
      continue;
    }
    var blad = bestand.getSheetByName("Aanvragen");
    if (!blad) continue;
    var koppen = blad.getRange(1, 1, 1, 20).getValues()[0];
    if (String(koppen[15] || "").trim() === "Betaalreferentie") {
      return { blad: blad, bestandId: kandidaten[i].getId() };
    }
  }

  /* geen van de kandidaten heeft het herkenbare tabblad: pak de
     eerste en bouw het tabblad als die niet bestaat */
  var beste = SpreadsheetApp.openById(kandidaten[0].getId());
  var bladBeste = beste.getSheetByName("Aanvragen") ||
                  beste.insertSheet("Aanvragen");
  return { blad: bladBeste, bestandId: kandidaten[0].getId() };
}
