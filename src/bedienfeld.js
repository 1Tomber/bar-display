'use strict';

// Das Bedienfeld auf dem Touch-Bildschirm am Geraet.
//
// Gesperrt zeigt es Uhr, Datum, den QR-Code zum Verbinden mit dem Funkzugang
// und ein paar Zustandszeilen - das ist der Normalfall, ein Fingertipp im
// Vorbeigehen soll nichts verstellen. Entsperrt wird, indem man den Knauf
// unten rechts einmal quer ueber die Spur wischt; nach eineinhalb Minuten
// ohne Beruehrung sperrt es sich von selbst wieder.
//
// Entsperrt gibt es vier Seiten: die Uhr stellen (fuer ein Geraet ohne Netz),
// Tag und Nacht, das Plakat (Genre, sichtbare Hoehe) und das Netz (Funkzugang
// an/aus, Adressen). Gespeichert wird ueber dieselbe Schnittstelle wie von der
// Einstellungsseite; als Aufruf vom Geraet selbst braucht es keine PIN.
//
// Laeuft als klassisches <script> nach common.js, qr.js und plakat.js in
// plakat.html - nur wenn es das Element #bedienfeld gibt.
(function () {
  if (typeof document === 'undefined') return;
  const wurzel = document.getElementById('bedienfeld');
  if (!wurzel) return;
  // Ohne zweiten Bildschirm ist das Fenster nur so breit wie die Saeule - dann
  // gibt es hier nichts zu tun, und der Dienst wird nicht alle 20 s gefragt.
  if (window.innerWidth < 224 + 400) { wurzel.remove(); return; }

  const SPERRE_NACH_MS = 90000;    // ohne Beruehrung wieder sperren

  let cfg = null, ap = null, zeit = null, gesperrt = true, sperrUhr = null, seite = 'uhr';
  // Beim Stellen der Uhr: die Zahlen, die gerade eingestellt werden (lokal)
  let stell = null;

  const $ = (id) => document.getElementById(id);
  const h = (tag, klasse, text) => { const e = document.createElement(tag); if (klasse) e.className = klasse; if (text != null) e.textContent = text; return e; };
  const jetzt = () => new Date(Date.now() + zeitVersatz(cfg && cfg.settings));
  const MONATE = ['Jan.', 'Feb.', 'März', 'Apr.', 'Mai', 'Juni', 'Juli', 'Aug.', 'Sep.', 'Okt.', 'Nov.', 'Dez.'];

  // -------------------------------------------------------------------------
  // Geruest
  // -------------------------------------------------------------------------
  wurzel.innerHTML =
    '<div id="bfSperre">' +
      '<div><div class="bfQr leer" id="bfQr"></div><div class="bfNetzText" id="bfNetzText"></div></div>' +
      '<div class="bfRechts"><div class="bfUhr mono" id="bfUhr">--:--</div><div class="bfDatum" id="bfDatum"></div>' +
        '<div class="bfZeilen" id="bfZeilen"></div>' +
        '<div class="bfSchieber" id="bfSchieber"><span>Zum Entsperren wischen</span><div class="bfKnauf" id="bfKnauf">&rsaquo;</div></div>' +
      '</div>' +
    '</div>' +
    '<div id="bfMenue" class="hidden">' +
      '<div id="bfReiter">' +
        '<button data-seite="uhr">Uhr</button><button data-seite="tagnacht">Tag &amp; Nacht</button>' +
        '<button data-seite="plakat">Plakat</button><button data-seite="netz">Netz</button>' +
        '<button class="bfSperren" id="bfSperren">Sperren</button>' +
      '</div>' +
      '<div id="bfInhalt">' +
        '<div class="bfSeite" data-seite="uhr"></div><div class="bfSeite" data-seite="tagnacht"></div>' +
        '<div class="bfSeite" data-seite="plakat"></div><div class="bfSeite" data-seite="netz"></div>' +
      '</div>' +
    '</div>' +
    '<div id="bfTasten" class="hidden"></div>';

  // -------------------------------------------------------------------------
  // Sperren und Entsperren
  // -------------------------------------------------------------------------
  function sperren() {
    gesperrt = true; stell = null;
    $('bfSperre').classList.remove('hidden');
    $('bfMenue').classList.add('hidden');
    $('bfTasten').classList.add('hidden');
    sperreZeichnen();
  }
  // Ist eine PIN gesetzt (Einstellungen -> System), fragt das Bedienfeld sie
  // nach dem Wischen ab - geprueft vom Dienst, die PIN selbst kennt die Seite
  // nicht. Ohne PIN reicht das Wischen.
  // Gesetzt ist die PIN, wenn der Dienst die Marke pinAktiv mitgibt (beim Laden)
  // oder die Einstellungen gerade frisch hereinkamen und die PIN selbst tragen.
  const pinGesetzt = () => !!(cfg && cfg.settings && (cfg.settings.pinAktiv || String(cfg.settings.pin || '').trim()));
  function entsperrenAnfragen() {
    if (!pinGesetzt() || !window.api.anmelden) return entsperren();
    tasten('PIN eingeben', '', async (pin, fehl) => {
      let a = null;
      try { a = await window.api.anmelden(pin); } catch (e) { /* unten */ }
      if (a && a.ok) { $('bfTasten').classList.add('hidden'); entsperren(); }
      else fehl('PIN stimmt nicht.');
    }, { ziffern: true, maske: true });
  }

  function entsperren() {
    gesperrt = false;
    $('bfSperre').classList.add('hidden');
    $('bfMenue').classList.remove('hidden');
    seiteZeigen(seite);
    beruehrt();
  }
  function beruehrt() {
    clearTimeout(sperrUhr);
    if (!gesperrt) sperrUhr = setTimeout(sperren, SPERRE_NACH_MS);
  }
  wurzel.addEventListener('pointerdown', beruehrt, true);

  // Spur fuer die Einrichtung: jede Beruehrung (auch ausserhalb des Bedienfelds)
  // wandert mit Fensterkoordinaten an den Dienst - ssh und /api/beruehrung
  // zeigen dann, wo der Touch wirklich landet.
  document.addEventListener('pointerdown', (e) => {
    try {
      fetch('/api/beruehrung', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x: Math.round(e.clientX), y: Math.round(e.clientY), art: e.pointerType }) }).catch(() => {});
    } catch (err) { /* egal */ }
  }, true);

  // Wischen: den Knauf mit dem Finger ueber die Spur ziehen. Erst ab 85 % des
  // Wegs gilt es, sonst springt er zurueck - ein Streifen im Vorbeigehen
  // reicht nicht.
  (function schieber() {
    const spur = $('bfSchieber'), knauf = $('bfKnauf');
    let startX = null, weg = 0, zuege = 0, weitester = 0;
    const melden = (ende) => {
      try {
        fetch('/api/beruehrung', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: Math.round(weitester), y: zuege, art: 'wisch:' + ende }) }).catch(() => {});
      } catch (err) { /* egal */ }
    };
    const maxWeg = () => spur.clientWidth - knauf.offsetWidth - 8;
    const setzen = (px) => {
      weg = Math.max(0, Math.min(maxWeg(), px));
      knauf.style.transform = 'translateX(' + weg + 'px)';
      spur.style.setProperty('--anteil', String(weg / maxWeg()));
    };
    knauf.addEventListener('pointerdown', (e) => {
      e.preventDefault(); startX = e.clientX; zuege = 0; weitester = 0; knauf.classList.add('zieht');
      try { knauf.setPointerCapture(e.pointerId); } catch (err) { /* ohne Fang geht es auch */ }
    });
    knauf.addEventListener('pointermove', (e) => {
      if (startX === null) return;
      zuege++; setzen(e.clientX - startX); if (weg > weitester) weitester = weg;
    });
    const ende = (grund) => () => {
      if (startX === null) return;
      const geschafft = weg >= maxWeg() * 0.85;
      melden(grund + (geschafft ? ':auf' : ':zu'));
      startX = null; knauf.classList.remove('zieht'); setzen(0);
      if (geschafft) entsperrenAnfragen();
    };
    knauf.addEventListener('pointerup', ende('up'));
    knauf.addEventListener('pointercancel', ende('cancel'));
    knauf.addEventListener('lostpointercapture', ende('verloren'));
  })();
  $('bfSperren').addEventListener('click', sperren);

  // -------------------------------------------------------------------------
  // Sperrbildschirm
  // -------------------------------------------------------------------------
  function uhrZeichnen() {
    const t = jetzt();
    const u = $('bfUhr');
    const text = pad2(t.getHours()) + ':' + pad2(t.getMinutes());
    // Der Doppelpunkt blinkt wie auf der Saeule - nur neu aufbauen, wenn sich
    // die Minute aendert, sonst beginnt das Blinken jedes Mal von vorn.
    if (u.dataset.stand !== text) {
      u.dataset.stand = text;
      u.innerHTML = '<span>' + text.slice(0, 2) + '</span><span class="pkKolon">:</span><span>' + text.slice(3) + '</span>';
    }
    $('bfDatum').textContent = DAY_NAMES_LONG[t.getDay()] + ', ' + t.getDate() + '. ' + MONATE[t.getMonth()] + ' ' + t.getFullYear();
  }

  function sperreZeichnen() {
    uhrZeichnen();
    const qr = $('bfQr'), netz = $('bfNetzText');
    if (ap && ap.aktiv && ap.ssid && typeof qrcode === 'function') {
      try {
        const q = qrcode(0, 'M'); q.addData(wlanQrText(ap)); q.make();
        qr.innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
        qr.classList.remove('leer');
      } catch (e) { qr.textContent = 'QR-Code nicht darstellbar'; qr.classList.add('leer'); }
      netz.innerHTML = 'WLAN <b>' + escapeHtml(ap.ssid) + '</b>' + (ap.modus === 'wpa2' ? ' · Passwort im Code' : ' · ohne Passwort') +
        '<br>Bedienung: <b>http://' + escapeHtml(ap.ip || '10.42.0.1') + '</b>';
    } else {
      qr.innerHTML = ''; qr.classList.add('leer');
      qr.textContent = ap && ap.verfuegbar === false ? 'Kein Funkzugang auf diesem Geraet' : 'Funkzugang aus';
      const adressen = (zeit && zeit.adressen) || [];
      netz.innerHTML = adressen.length ? 'Bedienung im Netz:<br><b>http://' + escapeHtml(adressen[0]) + '</b>' : '';
    }
    const z = $('bfZeilen'); z.innerHTML = '';
    const s = (cfg && cfg.settings) || {};
    if (zeit && zeit.pruefbar === true) {
      z.appendChild(h('div', zeit.synchronisiert ? 'gut' : 'warn', zeit.synchronisiert ? 'Uhr aus dem Netz abgeglichen' : 'Uhr NICHT abgeglichen - unter Uhr stellen'));
    }
    if (zeitVersatz(s)) z.appendChild(h('div', 'warn', 'Probezeit laeuft'));
    const art = tagNachtArt(s);
    const nacht = istNacht(s, jetzt());
    z.appendChild(h('div', '', 'Farben: ' + (nacht ? 'Nacht' : 'Tag') + ' · ' +
      ({ aus: 'immer Tag', astro: 'nach Sonnenstand', fest: 'feste Zeiten', hand: 'von Hand' })[art]));
    if (zeit && zeit.adressen && zeit.adressen.length && ap && ap.aktiv) z.appendChild(h('div', '', 'Am Kabel: http://' + zeit.adressen.join(' · ')));
  }

  // -------------------------------------------------------------------------
  // Seiten
  // -------------------------------------------------------------------------
  function seiteZeigen(name) {
    seite = name;
    wurzel.querySelectorAll('#bfReiter button[data-seite]').forEach(b => b.classList.toggle('an', b.dataset.seite === name));
    wurzel.querySelectorAll('.bfSeite').forEach(p => p.classList.toggle('aktiv', p.dataset.seite === name));
    ({ uhr: seiteUhr, tagnacht: seiteTagNacht, plakat: seitePlakat, netz: seiteNetz })[name]();
  }
  wurzel.querySelectorAll('#bfReiter button[data-seite]').forEach(b => b.addEventListener('click', () => seiteZeigen(b.dataset.seite)));

  function knopf(text, klasse, tun) { const b = h('button', klasse, text); b.addEventListener('click', tun); return b; }
  function zeile(...kinder) { const z = h('div', 'bfZeile reihe'); kinder.forEach(k => z.appendChild(k)); return z; }

  let stillSpeichern = false;
  async function speichern(aendern, still) {
    if (!cfg) return;
    const neu = JSON.parse(JSON.stringify(cfg));
    aendern(neu.settings);
    stillSpeichern = !!still;
    try {
      const a = await window.api.saveConfig(neu);
      if (a && a.konflikt) { cfg = a.aktuell; }
      else if (a && a.settings) { cfg = a; }
    } catch (e) { /* die naechste Aenderung versucht es erneut */ }
    if (!still) seiteZeigen(seite);
    setTimeout(() => { stillSpeichern = false; }, 1500);
  }

  // ---- Uhr ----------------------------------------------------------------
  // Die Steller stellen zunaechst die Probezeit: die Anzeige tut so, als
  // waere es diese Zeit - zum Ausprobieren des Plakats am Aufbautag, ohne die
  // Uhr des Geraets anzufassen. "Geraetezeit" nimmt das zurueck. Die echte Uhr
  // stellt erst "Uhr wirklich stellen" (fuer ein Geraet ohne Netz), und "Zeit
  // aus dem Netz" schaltet den Zeitabgleich wieder ein.
  const WOCHENTAG = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const datumText = (d) => WOCHENTAG[d.getDay()] + ' ' + pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
  const uhrText = (d) => pad2(d.getHours()) + ':' + pad2(d.getMinutes());

  function seiteUhr() {
    const p = wurzel.querySelector('.bfSeite[data-seite="uhr"]'); p.innerHTML = '';
    const s = (cfg && cfg.settings) || {};
    const versatz = zeitVersatz(s);
    const anzeige = jetzt(), geraet = new Date();
    p.appendChild(h('div', versatz ? 'bfHinweis warn' : 'bfHinweis',
      (versatz ? 'Probezeit: die Anzeige zeigt ' : 'Die Anzeige zeigt die Geraetezeit: ') + uhrText(anzeige) + ' · ' + datumText(anzeige)));
    p.appendChild(h('div', 'bfHinweis', 'Geraet: ' + uhrText(geraet) + ' · ' + datumText(geraet) +
      (zeit && zeit.pruefbar === true ? (zeit.synchronisiert ? ' · aus dem Netz abgeglichen' : ' · KEIN Zeitabgleich') : '')));

    if (!stell) stell = { tag: anzeige.getDate(), monat: anzeige.getMonth() + 1, jahr: anzeige.getFullYear(), std: anzeige.getHours(), min: anzeige.getMinutes() };
    const gestellt = () => new Date(stell.jahr, stell.monat - 1, stell.tag, stell.std, stell.min, 0, 0);
    const werte = {};
    const zeigen = () => { for (const k of Object.keys(werte)) werte[k].textContent = k === 'jahr' ? String(stell[k]) : pad2(stell[k]); };
    // Jeder Dreh wird nach kurzem Warten als Probezeit gespeichert - die Saeule
    // zieht sofort nach, ohne dass man erst einen Knopf drueckt.
    let probeUhr = null;
    const probeSetzen = () => {
      clearTimeout(probeUhr);
      probeUhr = setTimeout(() => {
        const st = stell; if (!st) return;
        const ziel = new Date(st.jahr, st.monat - 1, st.tag, st.std, st.min, 0, 0);
        speichern(x => { x.zeitVersatz = ziel.getTime() - Date.now(); }, true);
      }, 400);
    };

    const st = h('div', 'bfSteller');
    const felder = [['tag', 'Tag', 1, 31], ['monat', 'Monat', 1, 12], ['jahr', 'Jahr', 2024, 2040], ['std', 'Stunde', 0, 23], ['min', 'Minute', 0, 59]];
    for (const [k, name, von, bis] of felder) {
      const box = h('div', 'bfSt');
      box.appendChild(h('small', '', name));
      werte[k] = h('div', 'bfWert mono', '');
      const dreh = (d) => { stell[k] = stell[k] + d; if (stell[k] > bis) stell[k] = von; if (stell[k] < von) stell[k] = bis; zeigen(); probeSetzen(); };
      box.appendChild(knopf('▲', '', () => dreh(1)));
      box.appendChild(werte[k]);
      box.appendChild(knopf('▼', '', () => dreh(-1)));
      st.appendChild(box);
    }
    zeigen();
    p.appendChild(st);

    // Die Tage mit Programm als Schnellwahl fuer das Datum
    const tage = plakatTage((cfg && cfg.timetable) || []);
    if (tage.length) {
      const z = h('div', 'bfZeile knapp');
      for (const t of tage) {
        const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        const d = new Date(+m[1], +m[2] - 1, +m[3]);
        const b = knopf(WOCHENTAG[d.getDay()] + ' ' + m[3] + '.' + m[2] + '.', '', () => { stell.jahr = +m[1]; stell.monat = +m[2]; stell.tag = +m[3]; zeigen(); probeSetzen(); });
        if (stell.jahr === +m[1] && stell.monat === +m[2] && stell.tag === +m[3]) b.classList.add('an');
        z.appendChild(b);
      }
      p.appendChild(z);
    }

    p.appendChild(zeile(
      knopf('Geraetezeit (Probezeit aus)', versatz ? '' : 'an', () => { stell = null; speichern(x => { x.zeitVersatz = 0; }); })));

    if (zeit && zeit.stellbar) {
      p.appendChild(zeile(
        knopf('Uhr wirklich stellen', '', async () => {
          const a = await window.api.uhrStellen(Math.round(gestellt().getTime() / 1000)).catch(() => ({ fehler: 'keine Antwort' }));
          stell = null; await zeitHolen(); seiteUhr();
          if (a && a.fehler) p.appendChild(h('div', 'bfHinweis warn', a.fehler));
        }),
        knopf('Zeit aus dem Netz', '', async () => {
          const a = await window.api.uhrNtp().catch(() => ({ fehler: 'keine Antwort' }));
          stell = null; await zeitHolen(); seiteUhr();
          if (a && a.fehler) p.appendChild(h('div', 'bfHinweis warn', a.fehler));
        })));
    }
  }

  // ---- Tag und Nacht ------------------------------------------------------
  function seiteTagNacht() {
    const p = wurzel.querySelector('.bfSeite[data-seite="tagnacht"]'); p.innerHTML = '';
    const s = (cfg && cfg.settings) || {};
    const art = tagNachtArt(s);
    const arten = [['aus', 'Immer Tag'], ['astro', 'Sonnenstand'], ['fest', 'Feste Zeiten'], ['hand', 'Von Hand']];
    p.appendChild(zeile(...arten.map(([w, t]) => knopf(t, w === art ? 'an' : '', () => speichern(x => { x.tagNacht = w; })))));

    if (art === 'hand') {
      p.appendChild(zeile(
        knopf('Tag', s.tagNachtHand !== 'nacht' ? 'an' : '', () => speichern(x => { x.tagNachtHand = 'tag'; })),
        knopf('Nacht', s.tagNachtHand === 'nacht' ? 'an' : '', () => speichern(x => { x.tagNachtHand = 'nacht'; }))));
    }
    if (art === 'fest') {
      p.appendChild(h('div', 'bfHinweis', 'Tag von ' + (s.tagVon || '07:00') + ' bis ' + (s.tagBis || '20:00') + ' - die Zeiten stellt die Einstellungsseite.'));
    }
    if (art === 'astro') {
      const ort = astroStandort(s);
      const tag = astroTag(s, jetzt());
      const fmt = (d) => d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '--:--';
      p.appendChild(h('div', 'bfHinweis', ort
        ? 'Standort ' + s.astroBreite + ' / ' + s.astroLaenge + '  ·  heute Tag von ' + fmt(tag && tag.beginn) + ' bis ' + fmt(tag && tag.ende)
        : 'Kein Standort - dann bleibt es Tag.'));
      p.appendChild(zeile(
        knopf('Breite ' + (s.astroBreite || '–'), '', () => tasten('Breite (Nord), z.B. 49,349', s.astroBreite, (w) => speichern(x => { x.astroBreite = w; }))),
        knopf('Länge ' + (s.astroLaenge || '–'), '', () => tasten('Länge (Ost), z.B. 7,116', s.astroLaenge, (w) => speichern(x => { x.astroLaenge = w; })))));
      const st = h('div', 'bfSteller');
      for (const [k, name] of [['astroVersatzAuf', 'Morgens ±min'], ['astroVersatzUnter', 'Abends ±min']]) {
        const box = h('div', 'bfSt');
        box.appendChild(h('small', '', name));
        box.appendChild(knopf('+15', '', () => speichern(x => { x[k] = astroVersatz(Number(x[k] || 0) + 15); })));
        box.appendChild(h('div', 'bfWert mono', String(astroVersatz(s[k]))));
        box.appendChild(knopf('−15', '', () => speichern(x => { x[k] = astroVersatz(Number(x[k] || 0) - 15); })));
        st.appendChild(box);
      }
      p.appendChild(st);
    }
    p.appendChild(h('div', 'bfHinweis', 'Gerade: ' + (istNacht(s, jetzt()) ? 'Nachtfarben' : 'Tagfarben')));
  }

  // ---- Plakat -------------------------------------------------------------
  function seitePlakat() {
    const p = wurzel.querySelector('.bfSeite[data-seite="plakat"]'); p.innerHTML = '';
    const s = (cfg && cfg.settings) || {};
    p.appendChild(zeile(
      knopf('Genre zeigen', s.plakatGenre !== false ? 'an' : '', () => speichern(x => { x.plakatGenre = true; })),
      knopf('Genre aus', s.plakatGenre === false ? 'an' : '', () => speichern(x => { x.plakatGenre = false; }))));
    const hoehe = plakatHoehe(s);
    p.appendChild(h('div', 'bfHinweis', 'Sichtbare Hoehe: ' + hoehe + ' px (784 = alles; manche Wand leuchtet nicht bis unten)'));
    p.appendChild(zeile(
      knopf('784', hoehe === 784 ? 'an' : '', () => speichern(x => { x.plakatHoehe = 784; })),
      knopf('756', hoehe === 756 ? 'an' : '', () => speichern(x => { x.plakatHoehe = 756; })),
      knopf('−4', '', () => speichern(x => { x.plakatHoehe = plakatHoehe(x) - 4; })),
      knopf('+4', '', () => speichern(x => { x.plakatHoehe = plakatHoehe(x) + 4; }))));
    // Reihenfolge der Orte: alle, die im Programm vorkommen, in der eingestellten
    // Reihenfolge - und je ein Pfeil nach oben und unten
    const orte = plakatOrte(s);
    for (const a of (cfg && cfg.timetable) || []) { const n = (a.venue || '').trim(); if (n && !orte.includes(n)) orte.push(n); }
    if (orte.length > 1) {
      p.appendChild(h('div', 'bfHinweis', 'Reihenfolge der Orte:'));
      orte.forEach((name, i) => {
        const z = h('div', 'bfZeile knapp');
        const tausch = (j) => speichern(x => { const o = orte.slice(); [o[i], o[j]] = [o[j], o[i]]; x.plakatOrte = o.join('\n'); });
        const hoch = knopf('▲', '', () => tausch(i - 1)); hoch.disabled = i === 0;
        const runter = knopf('▼', '', () => tausch(i + 1)); runter.disabled = i === orte.length - 1;
        z.appendChild(hoch); z.appendChild(runter); z.appendChild(h('span', 'mono', name));
        p.appendChild(z);
      });
    }
    const versatz = zeitVersatz(s);
    p.appendChild(h('div', 'bfHinweis', versatz ? 'Probezeit laeuft - die Saeule zeigt ' + pad2(jetzt().getHours()) + ':' + pad2(jetzt().getMinutes()) : 'Keine Probezeit - die Saeule zeigt die echte Uhr.'));
    if (versatz) p.appendChild(zeile(knopf('Probezeit beenden', 'an', () => speichern(x => { x.zeitVersatz = 0; }))));
  }

  // ---- Netz ---------------------------------------------------------------
  function seiteNetz() {
    const p = wurzel.querySelector('.bfSeite[data-seite="netz"]'); p.innerHTML = '';
    const adressen = (zeit && zeit.adressen) || [];
    p.appendChild(h('div', 'bfHinweis', adressen.length ? 'Am Kabel: http://' + adressen.join('  ·  http://') : 'Kein Kabelnetz.'));
    if (!ap || ap.verfuegbar === false) { p.appendChild(h('div', 'bfHinweis', 'Auf diesem Geraet gibt es keinen Funkzugang.')); return; }
    p.appendChild(h('div', 'bfHinweis', ap.aktiv
      ? 'Funkzugang an: ' + ap.ssid + ' (' + (ap.modus === 'wpa2' ? 'mit Passwort' : 'ohne Passwort') + (ap.versteckt ? ', versteckt' : '') + ') · http://' + (ap.ip || '10.42.0.1') + (ap.geraete ? ' · ' + ap.geraete + ' verbunden' : '')
      : 'Funkzugang aus' + (ap.ssid ? ' (' + ap.ssid + ')' : '')));
    if (ap.fehler) p.appendChild(h('div', 'bfHinweis warn', ap.fehler));
    const ssid = ap.ssid || 'PLAKAT', versteckt = !!ap.versteckt;
    const mitPasswort = { modus: 'wpa2', ssid, schluessel: ap.schluessel, versteckt };
    p.appendChild(zeile(
      knopf('Aus', !ap.aktiv ? 'an' : '', () => apSchalten({ modus: 'aus' })),
      knopf('Offen', ap.aktiv && ap.modus === 'offen' ? 'an' : '', () => apSchalten({ modus: 'offen', ssid, versteckt })),
      ap.schluessel ? knopf('Mit Passwort', ap.aktiv && ap.modus === 'wpa2' ? 'an' : '', () => apSchalten(mitPasswort)) : h('span', 'bfHinweis', 'Passwort: nur von der Einstellungsseite')));
    if (ap.aktiv) p.appendChild(zeile(
      knopf('Name sichtbar', !versteckt ? 'an' : '', () => apSchalten({ modus: ap.modus, ssid, schluessel: ap.schluessel, versteckt: false })),
      knopf('Name versteckt', versteckt ? 'an' : '', () => apSchalten({ modus: ap.modus, ssid, schluessel: ap.schluessel, versteckt: true }))));
  }

  let apLaeuft = false;
  async function apSchalten(w) {
    if (apLaeuft) return;
    apLaeuft = true;
    const p = wurzel.querySelector('.bfSeite[data-seite="netz"]');
    p.querySelectorAll('button').forEach(b => { b.disabled = true; });
    p.appendChild(h('div', 'bfHinweis warn', 'Funkzugang wird umgestellt - das dauert bis zu zwei Minuten, Handys verlieren kurz die Verbindung.'));
    beruehrt();
    try { const a = await window.api.apAnwenden(w); if (a && a.verfuegbar) ap = a; } catch (e) { /* unten neu holen */ }
    apLaeuft = false;
    await apHolen();
    beruehrt();
    if (!gesperrt) seiteZeigen(seite);
  }

  // ---- Ziffernblock -------------------------------------------------------
  // Ziffernblock. `fertig(text, fehl)` bekommt die Eingabe und eine Funktion,
  // um eine Meldung zu zeigen und den Block offen zu lassen (falsche PIN).
  // Mit optionen.ziffern gibt es weder Minus noch Komma, mit optionen.maske
  // Punkte statt Zahlen.
  function tasten(titel, wert, fertig, optionen) {
    const o = optionen || {};
    const box = $('bfTasten'); box.innerHTML = ''; box.classList.remove('hidden');
    let text = String(wert || '');
    const links = h('div');
    links.appendChild(h('div', 'bfHinweis', titel));
    const anzeige = h('div', 'bfEingabe mono', ' ');
    const zeigen = () => { anzeige.textContent = (o.maske ? '•'.repeat(text.length) : text) || ' '; };
    zeigen();
    links.appendChild(anzeige);
    const meldung = h('div', 'bfHinweis warn', '');
    links.appendChild(meldung);
    const fehl = (t) => { meldung.textContent = t; text = ''; zeigen(); };
    const unten = h('div', 'bfZeile'); unten.style.marginTop = '16px';
    unten.appendChild(knopf('Übernehmen', 'an', () => { if (o.ziffern) fertig(text.trim(), fehl); else { box.classList.add('hidden'); fertig(text.trim(), fehl); } }));
    unten.appendChild(knopf('Abbrechen', '', () => box.classList.add('hidden')));
    links.appendChild(unten);
    const block = h('div', 'bfBlock');
    const tastenReihe = o.ziffern ? ['7', '8', '9', '4', '5', '6', '1', '2', '3', '', '0', '⌫'] : ['7', '8', '9', '4', '5', '6', '1', '2', '3', '−', '0', ',', '⌫'];
    for (const t of tastenReihe) {
      if (t === '') { block.appendChild(h('span')); continue; }
      block.appendChild(knopf(t, '', () => {
        if (t === '⌫') text = text.slice(0, -1);
        else if (t === '−') text = text.startsWith('-') ? text.slice(1) : '-' + text;
        else if (text.length < 12) text += t;
        zeigen();
      }));
    }
    box.appendChild(links); box.appendChild(block);
  }

  // -------------------------------------------------------------------------
  // Daten holen
  // -------------------------------------------------------------------------
  async function apHolen() {
    if (!window.api.apStatus) { ap = { verfuegbar: false }; return; }
    try { ap = await window.api.apStatus(); } catch (e) { /* alter Stand bleibt */ }
  }
  async function zeitHolen() {
    try {
      const z = await window.api.zeitStatus();
      const f = window.api.fernInfo ? await window.api.fernInfo().catch(() => null) : null;
      // Die Adresse des Funkzugangs steht in der Liste mit drin - die gehoert
      // aber zum WLAN, nicht zum Kabel.
      const eigene = ((f && f.adressen) || []).filter(a => !(ap && a === ap.ip) && a !== '10.42.0.1');
      zeit = Object.assign({}, z, { adressen: eigene });
    } catch (e) { /* alter Stand bleibt */ }
  }
  async function auffrischen() {
    await Promise.all([apHolen(), zeitHolen()]);
    if (gesperrt) sperreZeichnen(); else if (seite === 'netz' || seite === 'uhr') seiteZeigen(seite);
  }

  window.api.getConfig().then((c) => { cfg = c; auffrischen(); });
  window.api.onConfigChanged((c) => { cfg = c; if (gesperrt) sperreZeichnen(); else if (!stillSpeichern) seiteZeigen(seite); });
  setInterval(uhrZeichnen, 1000);
  setInterval(auffrischen, 20000);
  sperren();
  // Zum Ansehen im Browser am Rechner: /plakat?entsperrt startet offen
  if (new URLSearchParams(location.search).has('entsperrt')) entsperren();
})();
