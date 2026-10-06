'use strict';

// Das Plakat: der Tagesplan aller Orte auf einer 224 x 784 Pixel hohen Saeule.
//
// Portiert aus dem Entwurf "ProgrammePanel Plakat" (Claude Design). Die Anzeige
// zeigt immer nur den laufenden Tag: oben Sticker und Uhr, dann je Ort ein
// Ziegelkopf mit den Acts, unten QR-Code, Ziegelfeld und die Marke des Hauses
// (eine Datei aus dem Logo-Ordner, wenn eine hinterlegt ist). Der laufende Act
// bekommt "JETZT", vorbei ist, wer gedimmt dasteht - verschwinden tut nichts.
//
// Wird als klassisches <script> geladen, nach common.js, suncalc.js und qr.js.
// Die Rechenlogik (Zustand der Acts, Ziegelraster) ist bewusst ohne DOM
// geschrieben, damit sie sich in test/plakat.test.js pruefen laesst.

// ---------------------------------------------------------------------------
// Acts eines Tages, nach Orten
// ---------------------------------------------------------------------------

// Ein Act hat entweder eine Zeit (start), oder keine. Mit Zeit gilt:
//   end gesetzt      -> Fenster-Act (xstage 18:00-23:00): kein JETZT, nur vorbei
//   dauer gesetzt    -> laeuft start..start+dauer Minuten, dann vorbei
//   sonst            -> laeuft bis zum naechsten spaeteren Start am selben Ort,
//                       oder bis Tagesende
// Ohne Zeit (Walking Acts) gibt es weder JETZT noch vorbei.
function plakatOrte(settings) {
  const roh = String((settings || {}).plakatOrte || '');
  return roh.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

// Wie viele Zeilen die Wand wirklich zeigt. Manche Wand meldet 784, leuchtet
// aber nur bis Zeile 755 - der Fuss rueckt dann herauf, damit QR-Code und
// Marke nicht im Dunkeln haengen. Unsinn (leer, 0, Buchstaben) heisst: alle.
const PLAKAT_HOEHE = 784;
function plakatHoehe(settings) {
  const n = Math.round(Number((settings || {}).plakatHoehe));
  return Number.isFinite(n) && n >= 300 && n <= 2000 ? n : PLAKAT_HOEHE;
}

/** Die Tage, an denen etwas eingetragen ist - sortiert, ISO. */
function plakatTage(timetable) {
  const tage = new Set();
  for (const e of timetable || []) if (e && /^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) tage.add(e.date);
  return [...tage].sort();
}

// Welcher Tag ist "heute"? Vor sechs Uhr morgens zaehlt noch der Vorabend.
// Gibt es heute nichts, kommt der naechste Tag mit Programm - oder der letzte.
function plakatTagWaehlen(timetable, jetzt) {
  const tage = plakatTage(timetable);
  if (!tage.length) return null;
  const d = new Date(jetzt.getTime());
  if (d.getHours() < 6) d.setDate(d.getDate() - 1);
  const heute = todayISO(d);
  if (tage.includes(heute)) return heute;
  return tage.find(t => t > heute) || tage[tage.length - 1];
}

// Minuten seit Mitternacht des Plakattages - ueber Mitternacht hinaus (25:30)
function plakatMinuten(datum, jetzt) {
  const m = datum.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tag0 = new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
  return Math.round((jetzt.getTime() - tag0.getTime()) / 60000);
}

function plakatTagesende(acts, settings) {
  const fest = toMinutes((settings || {}).plakatEnde);
  if (fest !== null) {
    // Ein Ende vor dem fruehesten Start liegt nach Mitternacht
    const starts = acts.map(a => toMinutes(a.start)).filter(x => x !== null);
    return starts.length && fest < Math.min(...starts) ? fest + 1440 : fest;
  }
  let ende = null;
  for (const a of acts) {
    const s = toMinutes(a.start), e = toMinutes(a.end);
    if (s === null) continue;
    const bis = e === null ? s + 60 : (e <= s ? e + 1440 : e);
    if (ende === null || bis > ende) ende = bis;
  }
  return ende === null ? 23 * 60 : ende;
}

/**
 * Baut den Tagesplan: { datum, label, ende, orte: [{ name, acts: [...] }] }.
 * Jeder Act bekommt zustand 'jetzt' | 'vorbei' | 'offen' und die Felder, die
 * die Darstellung braucht. `jetztMin` sind Minuten seit Mitternacht des Tages.
 */
function plakatTag(timetable, datum, jetztMin, settings) {
  const s = settings || {};
  const acts = (timetable || []).filter(e => e && e.date === datum && (e.act || '').trim());
  const ende = plakatTagesende(acts, s);

  // Orte in der eingestellten Reihenfolge, unbekannte hinten in Reihenfolge des Auftretens
  const reihenfolge = plakatOrte(s);
  const namen = [];
  for (const n of reihenfolge) if (!namen.includes(n)) namen.push(n);
  for (const a of acts) {
    const n = (a.venue || '').trim() || 'PROGRAMM';
    if (!namen.includes(n)) namen.push(n);
  }

  const orte = [];
  for (const name of namen) {
    const eigene = acts.filter(a => ((a.venue || '').trim() || 'PROGRAMM') === name);
    if (!eigene.length) continue;
    const mitZeit = eigene.filter(a => toMinutes(a.start) !== null)
      .sort((x, y) => toMinutes(x.start) - toMinutes(y.start));
    const ohneZeit = eigene.filter(a => toMinutes(a.start) === null);
    const starts = mitZeit.map(a => toMinutes(a.start));

    const zeilen = [];
    for (const gruppe of plakatSlots(mitZeit)) {
      const a = gruppe[0];
      const fenster = toMinutes(a.end) !== null;          // ausdruecklich mit Ende
      let vorbei = true, laeuft = false;
      for (const slot of gruppe) {
        const von = toMinutes(slot.start);
        let bis = toMinutes(slot.end);
        if (bis !== null && bis <= von) bis += 1440;      // ueber Mitternacht
        const dauer = Math.round(Number(slot.dauer));
        if (bis === null && Number.isFinite(dauer) && dauer > 0) bis = von + dauer;
        if (bis === null) {
          const spaeter = starts.filter(x => x > von);
          bis = spaeter.length ? Math.min(...spaeter) : ende;
        }
        if (jetztMin < bis) vorbei = false;
        if (jetztMin < bis && jetztMin >= von) laeuft = true;
      }
      zeilen.push(plakatZeile(a, {
        zeit: fenster ? a.start + '–' + a.end : gruppe.map(x => x.start).join('+'),
        zustand: vorbei ? 'vorbei' : (laeuft && !fenster ? 'jetzt' : 'offen'),
        trenner: false
      }, s));
    }
    // Ein Strich vor dem ersten Act ohne Zeit - und noch einer, wenn nach einem
    // Act mit Hinweis ("Davor und in den Pausen: DJ Drei") wieder einer ohne
    // Hinweis kommt: die Lichtinstallationen stehen dann fuer sich.
    ohneZeit.forEach((a, i) => zeilen.push(plakatZeile(a, {
      zeit: '', zustand: 'offen',
      trenner: (i === 0 && mitZeit.length > 0) ||
        (i > 0 && !!(ohneZeit[i - 1].hinweis || '').trim() && !(a.hinweis || '').trim())
    }, s)));
    orte.push({ name, acts: zeilen });
  }

  const m = datum.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return {
    datum, ende,
    label: DAY_NAMES_LONG[d.getDay()].toUpperCase() + ' · ' + pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.',
    endeText: 'ENDE · ' + minutesToHHMM(ende),
    orte
  };
}

// Derselbe Act mehrmals am Tag am selben Ort (dieselbe Band 20:00 und 22:00)
// ist eine Zeile mit beiden Zeiten: "20:00+22:00" - ohne Leerzeichen, wie im
// Entwurf, sonst bleibt neben der Zeit kein Platz fuer den Namen. Zusammengelegt wird nur,
// was gleich heisst, dasselbe Genre traegt und kein eigenes Ende hat -
// Fenster-Acts bleiben, was sie sind. `mitZeit` kommt nach Start sortiert.
function plakatSlots(mitZeit) {
  const schluessel = a => (a.act || '').trim().toLowerCase() + '\n' + (a.info || '').trim().toLowerCase();
  const gruppen = [];
  for (const a of mitZeit) {
    const offen = toMinutes(a.end) === null;
    const g = offen && gruppen.find(x => x.offen && x.schluessel === schluessel(a));
    if (g) g.slots.push(a); else gruppen.push({ schluessel: schluessel(a), offen, slots: [a] });
  }
  return gruppen.map(g => g.slots);
}

// Wohin mit dem Genre? Auf einer Zeile hinter den Namen, wenn es passt; sonst
// im Fluss nach dem letzten Wort; sonst rechtsbuendig in einer eigenen Zeile.
// Die Breiten sind Schaetzungen pro Zeichen bei 208px Zeilenbreite - wie im
// Entwurf: Zeit 8.4px, Name 7.3px, Genre 5.8px.
function plakatZeile(a, lage, settings) {
  const genre = settings.plakatGenre !== false && (a.info || '').trim();
  const meta = genre ? '[' + a.info.trim() + ']' : '';
  const zeit = lage.zeit;
  const zeitBreite = zeit ? zeit.length * 8.4 + 6 : 0;
  const nameSpalte = 208 - zeitBreite;
  const breite = zeitBreite + a.act.length * 7.3 + 6 + meta.length * 5.8;
  const bricht = a.act.length * 7.3 > nameSpalte;
  const inline = !!meta && (zeit ? breite <= 214 : breite <= 252);
  const fluss = !!meta && !inline && bricht && meta.length * 6.7 <= nameSpalte;
  return {
    act: a.act, meta, zeit, hinweis: (a.hinweis || '').trim(),
    zustand: lage.zustand, trenner: lage.trenner,
    genreLage: !meta ? 'keins' : inline ? 'inline' : fluss ? 'fluss' : 'darunter',
    // Beim JETZT-Block: passt der Name in die Spalte neben der Zeit, rutscht das
    // Genre hoch neben die Zeit; sonst steht es unter dem Namen.
    metaHoch: a.act.length * 7.6 <= nameSpalte
  };
}

// ---------------------------------------------------------------------------
// Ziegel
// ---------------------------------------------------------------------------
// Ein Raster ueberall: 7px Teilung, 6px Ziegel, 1px Fuge, Schachbrett
// (Spalte + Reihe gerade). Spalten sind 1 oder 2 Zellen breit, nach dem Muster
// U, und gelten fuer alle Reihen - so stehen die Ziegel in geraden Stapeln.
//
// Alles liegt auf ganzen Pixeln: ein Ziegel beginnt am Zellenanfang und ist
// 6 hoch, die Fuge ist die letzte Spalte und Zeile der Zelle. Der Entwurf
// setzte die Ziegel um einen halben Pixel versetzt mit runden Ecken - auf der
// LED-Wand wurde daraus ein weicher Rand ueber zwei Pixel. Die runden Ecken
// (rx 1.5) bleiben: auf ganzen Pixeln daempfen sie nur den Eckpixel selbst.
const ZIEGEL = { zelle: 7, hoehe: 6 };
function ziegelDicht(reihen, samen, breite) {
  const U = [2, 1, 1, 2, 1, 2, 2, 1], C = ZIEGEL.zelle, aus = [], spalten = [];
  let x = 0, i = samen;
  while (x + C <= breite) {
    const w = Math.min(U[i % U.length] * C, Math.floor((breite - x) / C) * C);
    spalten.push([x, w]); x += w; i++;
  }
  for (const r of reihen) {
    spalten.forEach(([sx, w], c) => {
      if ((c + r) % 2 === 0) aus.push({ x: sx, y: r * C, w: w - 1 });
    });
  }
  return aus;
}

// Ortskopf (208 x 28): der Name links, rechts daneben vier Reihen Ziegel.
// Reihe 0 und 3 beginnen mit einem Balken in Namenslaenge, Reihe 1 und 2
// lassen den Namen frei. Der obere Balken schluckt den ersten Ziegel seiner
// Reihe, der untere endet eine Fuge vor dem ersten Ziegel der Reihe darueber.
function ziegelOrtskopf(name, index) {
  const textW = Math.round(name.length * 9.3 + 4);
  const restW = Math.floor((208 - textW - 3) / 7) * 7;
  const startX = 208 - restW;
  const samen = index * 2;
  const alle = ziegelDicht([0, 1, 2, 3], samen, restW).map(b => ({ ...b, x: b.x + startX }));
  const erster0 = alle.find(b => b.y < 7);
  const reicht = erster0 ? erster0.x + erster0.w : textW - 4;
  const rest = alle.filter(b => b !== erster0);
  const erster2 = rest.find(b => b.y > 13 && b.y < 20);
  const reichtUnten = erster2 ? erster2.x - 1 : textW - 4;
  return [{ x: 0, y: 0, w: reicht, balken: true }, { x: 0, y: 21, w: reichtUnten, balken: true }, ...rest];
}

// Fuss (208 x 77): QR oben links, ENDE oben rechts, rechts vom QR das Ziegelfeld,
// unten PROGRAMM mit Balken, das G unten rechts. Alles auf dem 7px-Raster.
const FUSS = { hoehe: 77, gH: 40, gW: 42 };
function ziegelFuss() {
  const gW = FUSS.gW;
  const QRX = Math.ceil((54 + 6) / 7) * 7, GX = Math.floor((208 - gW - 6) / 7) * 7;
  const PW = Math.round(8 * 9.3 + 4), PX = Math.ceil((PW + 3) / 7) * 7;
  const U = [1, 2, 3, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const spalten = [];
  { let x = QRX, k = 0; while (x + 7 <= 208) { const w = Math.min(U[k % U.length] * 7, Math.floor((208 - x) / 7) * 7); spalten.push([x, w]); x += w; k++; } }
  const feld = [];
  const reihe = (r, minX, maxX) => spalten.forEach(([x, w], c) => {
    if ((c + r) % 2 === 1 && x >= minX && x + w <= maxX) feld.push({ x, y: r * 7, w: w - 1 });
  });
  const EW = Math.round(12 * 8.4);                                      // 'ENDE · 23:00'
  const EX = spalten.map(c => c[0]).filter(x => x <= 208 - EW).pop() ?? QRX;
  for (let r = 0; r <= 7; r++) {
    if (r === 2) { reihe(r, QRX, EX); feld.push({ x: EX, y: 14, w: 208 - EX - 1, balken: true }); }
    else reihe(r, QRX, r <= 3 ? EX : GX);
  }
  for (let r = 8; r <= 9; r++) reihe(r, PX, GX);
  feld.push({ x: 0, y: 70, w: PX - 1, balken: true });
  reihe(10, PX, GX);
  return { feld, gW };
}

// ---------------------------------------------------------------------------
// Farben
// ---------------------------------------------------------------------------
// Die Farben des Entwurfs stehen in plakat.css. Wer andere will, traegt sie in
// den Einstellungen ein (Plakat-Karte); leer heisst: wie im Entwurf. Die
// abgeleiteten Toene (weiche Schrift, Hairline) werden aus Schrift und
// Hintergrund gemischt, damit sie zu jeder Wahl passen.
const PLAKAT_FARBEN = {
  tag:   { bg: '#ebf0f4', fg: '#000000', akzent: '#ff5a00', akzentText: '#d8501c', sticker: '#00dc00' },
  nacht: { bg: '#0e1216', fg: '#ebf0f4', akzent: '#ff5a00', akzentText: '#ff7a2e', sticker: '#00c800' }
};
function hexFarbe(t) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(t || '').trim());
  return m ? '#' + m[1].toLowerCase() : null;
}
// a und b als #rrggbb, t = Anteil von a (0..1)
function farbeMischen(a, b, t) {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const k = (s) => Math.round(((x >> s) & 255) * t + ((y >> s) & 255) * (1 - t));
  return '#' + [16, 8, 0].map(s => k(s).toString(16).padStart(2, '0')).join('');
}
/**
 * Die Marke unten rechts: eine Datei aus dem Logo-Ordner (branding/), 38 x 37
 * Pixel, fuer die Nacht wahlweise eine helle Fassung. Leer heisst: keine Marke.
 * Der Pfad ist bewusst relativ - der Dienst reicht /branding aus dem Ordner der
 * Bar und faellt sonst auf src/branding zurueck. Nur ein Dateiname, kein Pfad.
 */
function plakatMarke(settings, nacht) {
  const s = settings || {};
  const tag = String(s.plakatMarke || '').trim();
  const datei = (nacht && String(s.plakatMarkeNacht || '').trim()) || tag;
  if (!datei || datei.includes('/') || datei.includes('\\') || datei.startsWith('.')) return '';
  return 'branding/' + encodeURIComponent(datei);
}

/** Wie das JETZT-Schild pulsiert: Tiefe 0..1 und Takt in Sekunden, als CSS-Variablen. */
function jetztPulsStil(settings) {
  const s = settings || {};
  const tiefe = Number(s.plakatJetztPuls), dauer = Number(s.plakatJetztPulsDauer);
  const t = Number.isFinite(tiefe) ? Math.max(0, Math.min(100, tiefe)) / 100 : 0.35;
  const d = Number.isFinite(dauer) && dauer > 0 ? Math.min(60, dauer) : 2;
  return '--jetzt-tiefe:' + t.toFixed(2) + ';--jetzt-dauer:' + d + 's;';
}

/** Wie der Sticker pulsiert: Groesse (0..1), Takt (s), Drehung (Grad) und die Art. */
function stickerPuls(settings) {
  const s = settings || {};
  const groesse = Number(s.plakatStickerPuls), dauer = Number(s.plakatStickerPulsDauer), dreh = Number(s.plakatStickerPulsDrehung);
  const art = ['weich', 'linear', 'herz'].includes(s.plakatStickerPulsArt) ? s.plakatStickerPulsArt : 'weich';
  const g = Number.isFinite(groesse) ? Math.max(0, Math.min(100, groesse)) / 100 : 0.04;
  return {
    art: g > 0 ? art : 'aus',
    text: s.plakatStickerPulsText === true ? 'mit' : 'ohne',
    tiefe: g, dauer: Number.isFinite(dauer) && dauer > 0 ? Math.min(60, dauer) : 3,
    stil: '--sticker-tiefe:' + g.toFixed(3) + ';--sticker-dauer:' + (Number.isFinite(dauer) && dauer > 0 ? Math.min(60, dauer) : 3) + 's;' +
      '--sticker-dreh:' + (Number.isFinite(dreh) ? Math.max(-45, Math.min(45, dreh)) : 0) + 'deg;'
  };
}

/** Die CSS-Variablen fuer die Palette - leer, solange alles beim Entwurf bleibt. */
function plakatFarbenStil(settings, nacht) {
  const s = settings || {};
  const p = nacht ? 'plakatNacht' : 'plakatTag';
  const v = PLAKAT_FARBEN[nacht ? 'nacht' : 'tag'];
  const bg = hexFarbe(s[p + 'Bg']), fg = hexFarbe(s[p + 'Fg']), akzent = hexFarbe(s[p + 'Akzent']),
        akzentText = hexFarbe(s[p + 'AkzentText']), sticker = hexFarbe(s[p + 'Sticker']);
  if (!bg && !fg && !akzent && !akzentText && !sticker) return '';
  const B = bg || v.bg, F = fg || v.fg;
  return '--bg:' + B + ';--fg:' + F + ';--fg-soft:' + farbeMischen(F, B, 0.76) + ';--fg-mute:' + farbeMischen(F, B, 0.6) +
    ';--line:' + farbeMischen(F, B, 0.15) + ';--accent:' + (akzent || v.akzent) + ';--accent-text:' + (akzentText || v.akzentText) +
    ';--accent2:' + (sticker || v.sticker) + ';';
}

// Die Adresse hinter dem QR-Code. Ohne "https://" halten Handys den Text fuer
// einen Suchbegriff und landen bei Google - deshalb steht das Schema davor.
// Schema und Host duerfen gross sein (das ist egal), der Pfad bleibt, wie er
// eingegeben wurde: ob GROSS auch klappt, weiss nur der Server dahinter.
function plakatQrText(text) {
  let t = String(text || '').trim();
  if (!t) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = 'https://' + t;
  return t.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)/i, m => m.toUpperCase());
}

// QR-Code: 2px je Modul, ein Modul Rand, schwarz auf weiss. Nur Grossbuchstaben,
// Ziffern und wenige Zeichen -> der alphanumerische Modus spart Platz. Im Fuss
// ist neben dem PROGRAMM-Schild Platz fuer 25 Module (Version 2); dafuer geht
// die Fehlerkorrektur notfalls von M auf L herunter.
function plakatQr(text) {
  if (typeof qrcode !== 'function') return null;
  const t = plakatQrText(text);
  if (!t) return null;
  const alnum = /^[0-9A-Z $%*+\-./:]+$/.test(t);
  try {
    let q = null;
    for (const stufe of ['M', 'L']) {
      const k = qrcode(0, stufe);
      k.addData(t, alnum ? 'Alphanumeric' : 'Byte');
      k.make();
      if (!q || k.getModuleCount() < q.getModuleCount()) q = k;
      if (q.getModuleCount() <= 25) break;
    }
    const n = q.getModuleCount(), M = 2, Q = 1;
    const rects = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) rects.push({ x: (c + Q) * M, y: (r + Q) * M });
    return { px: (n + 2 * Q) * M, rects, text: t };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
// Die langen Balken (ueber und unter dem Ortsnamen, unter ENDE und PROGRAMM)
// tragen eine Klasse: die Welle laesst sie in Ruhe.
function rects(liste, h) {
  return liste.map(b => '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + (h || ZIEGEL.hoehe) + '" rx="1.5"' + (b.balken ? ' class="pkBalken"' : '') + '></rect>').join('');
}

// ---------------------------------------------------------------------------
// Glanz: eine Welle, in der die Ziegel einzeln aus- und wieder einblenden
// ---------------------------------------------------------------------------
// Kein Verlauf ueber den Ziegeln, sondern jeder Ziegel fuer sich: eine
// schraege Wellenfront wandert ueber das Plakat, und jeder Ziegel, den sie
// gerade streift, wird durchsichtig und kommt wieder - nah an der Front ganz,
// am Rand der Welle kaum. Die Front laeuft im Koordinatensystem des ganzen
// Plakats: plakatGlanzStarten() misst, wo jedes Ziegel-SVG sitzt. Einstellbar
// (Plakat-Karte): Dauer eines Durchlaufs, Pause, Breite der Welle, Tiefe
// (wie weit die Ziegel verschwinden oder schrumpfen), Winkel - und die Art:
// 'deckung' blendet die Ziegel aus, 'groesse' laesst sie um ihre Mitte
// schrumpfen und wieder wachsen.
const GLANZ = { dauer: 6, pause: 25, breite: 70, staerke: 100, winkel: 45 };
function glanzWerte(settings) {
  const s = settings || {};
  const z = (k, min, max) => { const n = Number(s['plakatGlanz' + k]); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : GLANZ[k.toLowerCase()]; };
  return { an: s.plakatGlanz === true, art: s.plakatGlanzArt === 'groesse' ? 'groesse' : 'deckung',
    dauer: z('Dauer', 1, 120), pause: z('Pause', 0, 3600), breite: z('Breite', 4, 400), staerke: z('Staerke', 0, 100), winkel: z('Winkel', -180, 180) };
}

/**
 * Die Welle in einem gezeichneten Plakat laufen lassen. Nach jedem Neuzeichnen
 * erneut aufrufen (die Lagen der SVGs werden dann frisch gemessen). Gibt eine
 * Funktion zurueck, die den Lauf beendet.
 */
function plakatGlanzStarten(behaelter, settings) {
  if (behaelter._glanzStopp) { behaelter._glanzStopp(); behaelter._glanzStopp = null; }
  const g = glanzWerte(settings);
  const plakat = behaelter.querySelector('.plakat');
  if (!g.an || !plakat) return () => {};
  const rad = g.winkel * Math.PI / 180, dx = Math.cos(rad), dy = Math.sin(rad);
  const pr = plakat.getBoundingClientRect();
  // Jeder Ziegel mit seiner Lage entlang der Wellenrichtung
  const ziegel = [];
  for (const svg of plakat.querySelectorAll('.pkOrtKopf svg, svg.pkFeld')) {
    const r = svg.getBoundingClientRect();
    for (const rect of svg.querySelectorAll('rect:not(.pkBalken)')) {
      const x = r.left - pr.left + rect.x.baseVal.value + rect.width.baseVal.value / 2;
      const y = r.top - pr.top + rect.y.baseVal.value + rect.height.baseVal.value / 2;
      const cx = rect.x.baseVal.value + rect.width.baseVal.value / 2, cy = rect.y.baseVal.value + rect.height.baseVal.value / 2;
      ziegel.push({ rect, d: x * dx + y * dy, cx, cy, op: 1 });
    }
  }
  if (!ziegel.length) return () => {};
  const halb = g.breite / 2, tiefe = g.staerke / 100;
  const ecken = [[0, 0], [pr.width, 0], [0, pr.height], [pr.width, pr.height]].map(([x, y]) => x * dx + y * dy);
  const von = Math.min(...ecken) - halb, bis = Math.max(...ecken) + halb;
  const dauerMs = g.dauer * 1000, pauseMs = g.pause * 1000;
  const start = performance.now();
  let stopp = false, zuletzt = 0;
  // op ist der Anteil, der vom Ziegel bleibt: Deckkraft oder Groesse
  const setzen = (z, op) => {
    if (Math.abs(op - z.op) < 0.02) return;
    z.op = op;
    if (g.art === 'groesse') {
      z.rect.setAttribute('transform', op >= 0.99 ? '' : 'translate(' + z.cx + ' ' + z.cy + ') scale(' + op.toFixed(3) + ') translate(' + (-z.cx) + ' ' + (-z.cy) + ')');
    } else {
      z.rect.setAttribute('opacity', op.toFixed(2));
    }
  };
  const schritt = (t) => {
    if (stopp) return;
    const phase = (t - start) % (dauerMs + pauseMs);
    if (phase < dauerMs) {
      // hoechstens 30 Bilder je Sekunde - der Pi hat auch noch anderes zu tun
      if (t - zuletzt >= 33) {
        zuletzt = t;
        const p = von + (bis - von) * (phase / dauerMs);
        for (const z of ziegel) {
          const a = Math.abs(z.d - p);
          setzen(z, a >= halb ? 1 : 1 - tiefe * (1 + Math.cos(Math.PI * a / halb)) / 2);
        }
      }
      requestAnimationFrame(schritt);
    } else {
      for (const z of ziegel) setzen(z, 1);
      setTimeout(() => requestAnimationFrame(schritt), Math.max(50, Math.min(pauseMs - (phase - dauerMs), 1000)));
    }
  };
  requestAnimationFrame(schritt);
  const ende = () => { stopp = true; for (const z of ziegel) setzen(z, 1); };
  behaelter._glanzStopp = ende;
  return ende;
}

// Die Scheibe atmet ueber eine SVG-Animation ihres Radius - ein CSS-Transform auf
// dem Kreis verschob ihn in Chromium (transform-box wird fuer animierte
// SVG-Kinder falsch aufgeloest). Pulsiert die Schrift mit, uebernimmt CSS den
// ganzen Sticker (plakat.css, data-sticker-text="mit").
function stickerAnimation(puls) {
  if (!puls || puls.art === 'aus' || puls.text === 'mit') return '';
  const r = 100, R = (100 * (1 + puls.tiefe)).toFixed(1), d = puls.dauer + 's';
  if (puls.art === 'herz') {
    const m = (100 * (1 + puls.tiefe * 0.4)).toFixed(1);
    return '<animate attributeName="r" values="' + [r, R, m, R, r, r].join(';') + '" keyTimes="0;0.1;0.2;0.3;0.4;1" ' +
      'calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0 0 1 1" dur="' + d + '" repeatCount="indefinite"></animate>';
  }
  const spline = puls.art === 'linear' ? 'calcMode="linear"' : 'calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"';
  return '<animate attributeName="r" values="' + r + ';' + R + ';' + r + '" keyTimes="0;0.5;1" ' + spline + ' dur="' + d + '" repeatCount="indefinite"></animate>';
}

function plakatSticker(text, puls) {
  const fs = Math.min(40, 150 / (Math.max(text.length, 5) * 0.62));
  return '<svg class="pkSticker" width="120" height="120" viewBox="0 0 200 200">' +
    '<circle cx="100" cy="100" r="100" fill="var(--surface-sticker)">' + stickerAnimation(puls) + '</circle>' +
    '<text x="100" y="100" transform="rotate(-9 100 100)" text-anchor="middle" dominant-baseline="central" ' +
    'fill="var(--on-accent2)" font-family="var(--font-mono)" font-weight="900" font-size="' + fs.toFixed(1) + '" ' +
    'textLength="150" lengthAdjust="spacingAndGlyphs">' + escapeHtml(text) + '</text></svg>';
}

function plakatActHtml(z) {
  const meta = '<span class="pkMeta">' + escapeHtml(z.meta) + '</span>';
  const klassen = 'pkAct pk-' + z.zustand + (z.trenner ? ' pkTrenner' : '') + ' pkGenre-' + z.genreLage;
  if (z.zustand === 'jetzt') {
    return '<div class="' + klassen + (z.metaHoch ? ' pkMetaHoch' : '') + '">' +
      '<div class="pkJetztSpalte"><div class="pkZeit">' + escapeHtml(z.zeit) + '</div>' +
      '<svg width="42" height="13" viewBox="0 0 42 13"><rect width="42" height="13" fill="var(--text-primary)"></rect>' +
      '<text x="21" y="7.5" dominant-baseline="central" text-anchor="middle" fill="var(--surface-panel)" ' +
      'font-family="var(--font-mono)" font-weight="900" font-size="10" letter-spacing=".02em">JETZT</text></svg></div>' +
      '<div class="pkName"><span>' + escapeHtml(z.act) + '</span>' + (z.genreLage === 'fluss' ? meta : '') + '</div>' +
      (z.meta && z.genreLage !== 'fluss' ? '<div class="pkMetaZeile">' + escapeHtml(z.meta) + '</div>' : '') +
      '</div>';
  }
  return '<div class="' + klassen + '">' +
    (z.hinweis ? '<div class="pkHinweis">' + escapeHtml(z.hinweis) + '</div>' : '') +
    '<div class="pkZeileFlex">' +
    (z.zeit ? '<div class="pkZeit">' + escapeHtml(z.zeit) + '</div>' : '') +
    '<div class="pkName"><span>' + escapeHtml(z.act) + '</span>' + (z.genreLage === 'fluss' ? meta : '') + '</div>' +
    (z.genreLage === 'inline' ? meta : '') +
    '</div>' +
    (z.genreLage === 'darunter' ? '<div class="pkMetaZeile">' + escapeHtml(z.meta) + '</div>' : '') +
    '</div>';
}

/**
 * Das ganze Plakat als HTML. `tag` kommt aus plakatTag(), `uhr` ist die Zeit
 * fuer die Kopfzeile (Date), `nacht` waehlt die Farben.
 */
function plakatHtml(tag, uhr, nacht, settings) {
  const s = settings || {};
  const hh = pad2(uhr.getHours()), mm = pad2(uhr.getMinutes());
  const orte = tag.orte.map((o, i) =>
    '<div class="pkOrt">' +
      '<div class="pkOrtKopf"><svg width="208" height="28" viewBox="0 0 208 28" fill="var(--brick)">' + rects(ziegelOrtskopf(o.name, i)) + '</svg>' +
      '<div class="pkOrtName">' + escapeHtml(o.name) + '</div></div>' +
      '<div class="pkActs">' + o.acts.map(plakatActHtml).join('') + '</div>' +
    '</div>').join('');

  const fuss = ziegelFuss();
  const qr = plakatQr(s.plakatQr || s.qrUrl || '');
  const marke = plakatMarke(s, nacht);
  const puls = stickerPuls(s);
  return '<div class="plakat" data-tageszeit="' + (nacht ? 'nacht' : 'tag') + '" data-sticker-puls="' + puls.art + '" data-sticker-text="' + puls.text + '" style="height:' + plakatHoehe(s) + 'px;' + jetztPulsStil(s) + puls.stil + plakatFarbenStil(s, nacht) + '">' +
    '<div class="pkKopf">' +
      '<div class="pkStickerBox">' + plakatSticker(s.plakatSticker || 'PROGRAMM', puls) + '</div>' +
      '<div class="pkKopfRechts"><div class="pkTagZeile">' + escapeHtml(tag.label) + '</div>' +
      '<div class="pkUhr"><span>' + hh + '</span><span class="pkKolon">:</span><span>' + mm + '</span></div></div>' +
    '</div>' +
    '<div class="pkOrte">' + orte + '</div>' +
    '<div class="pkFuss">' +
      (qr ? '<svg class="pkQr" width="' + qr.px + '" height="' + qr.px + '" viewBox="0 0 ' + qr.px + ' ' + qr.px + '" shape-rendering="crispEdges">' +
        qr.rects.map(r => '<rect x="' + r.x + '" y="' + r.y + '" width="2" height="2" fill="#000"></rect>').join('') + '</svg>' : '') +
      '<div class="pkEnde">' + escapeHtml(tag.endeText) + '</div>' +
      '<svg class="pkFeld" width="208" height="' + FUSS.hoehe + '" viewBox="0 0 208 ' + FUSS.hoehe + '" fill="var(--brick)">' + rects(fuss.feld) + '</svg>' +
      '<div class="pkProgramm">PROGRAMM</div>' +
      (marke ? '<img class="pkMarke" src="' + marke + '" alt="" width="38" height="37">' : '') +
    '</div>' +
  '</div>';
}

/** Alles in einem: Konfiguration + Zeitpunkt -> HTML. `datum` wahlweise fest. */
function plakatRendern(cfg, jetzt, opt) {
  const o = opt || {};
  const s = Object.assign({}, cfg.settings, o.settings || {});
  const datum = o.datum || plakatTagWaehlen(cfg.timetable, jetzt);
  if (!datum) return '<div class="plakat pkLeer" data-tageszeit="tag"><div>Noch kein Programm eingetragen.</div></div>';
  const tag = plakatTag(cfg.timetable, datum, plakatMinuten(datum, jetzt), s);
  const nacht = typeof o.nacht === 'boolean' ? o.nacht : istNacht(s, jetzt);
  return plakatHtml(tag, jetzt, nacht, s);
}

// ---------------------------------------------------------------------------
// Die Anzeige selbst: laeuft, wenn es #plakat gibt
// ---------------------------------------------------------------------------
(function () {
  if (typeof document === 'undefined') return;
  const wurzel = document.getElementById('plakat');
  if (!wurzel) return;
  let cfg = null, stand = '', uhrStand = '';

  const jetzt = () => new Date(Date.now() + zeitVersatz(cfg && cfg.settings));
  const uhrText = (t) => pad2(t.getHours()) + ':' + pad2(t.getMinutes());

  // Die Uhr nur anfassen, wenn sich die Minute aendert - jede Aenderung am
  // DOM wuerde den blinkenden Doppelpunkt von vorn beginnen lassen.
  function uhrStellen() {
    const uhr = wurzel.querySelector('.pkUhr');
    if (!uhr) return;
    const t = uhrText(jetzt());
    if (t === uhrStand) return;
    uhrStand = t;
    uhr.innerHTML = '<span>' + t.slice(0, 2) + '</span><span class="pkKolon">:</span><span>' + t.slice(3) + '</span>';
  }

  // Kommt suncalc.js beim Neuladen mitten im Neustart des Dienstes nicht an,
  // rechnet istNacht() stillschweigend mit Tag. Dann lieber einmal neu laden.
  let neuGeladen = false;
  function skripteDa() {
    if (tagNachtArt(cfg.settings) !== 'astro' || typeof SunCalc !== 'undefined' || neuGeladen) return true;
    neuGeladen = true;
    setTimeout(() => location.reload(), 5000);
    return false;
  }

  function zeichnen() {
    if (!cfg || !skripteDa()) return;
    document.body.dataset.rotation = String([0, 90, 180, 270].includes(Number(cfg.settings.rotation)) ? Number(cfg.settings.rotation) : 0);
    const html = plakatRendern(cfg, jetzt());
    // Nur neu aufbauen, wenn sich etwas ausser der Uhr geaendert hat
    const kern = html.replace(/<div class="pkUhr">.*?<\/div>/, '');
    if (kern !== stand) { wurzel.innerHTML = html; stand = kern; uhrStand = uhrText(jetzt()); plakatGlanzStarten(wurzel, cfg.settings); }
    uhrStellen();
  }

  window.api.getConfig().then((c) => { cfg = c; zeichnen(); });
  window.api.onConfigChanged((c) => { cfg = c; stand = ''; zeichnen(); });
  // Der Dienst war weg und ist wieder da (Neustart nach pi/sync.sh, Stromausfall):
  // die Seite neu laden, damit auch geaenderte Skripte und Stile ankommen.
  if (window.api.onReconnected) window.api.onReconnected(() => location.reload());
  setInterval(zeichnen, 10000);
  setInterval(uhrStellen, 1000);
})();
