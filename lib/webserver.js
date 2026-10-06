'use strict';

// Der Webdienst: liefert die Anzeige aus und bedient die Einstellungsseite
// fuers Handy.
//
// Frueher lag das komplett in pi/server.js und lief nur auf dem Raspberry Pi.
// Inzwischen soll die Fernbedienung auf jedem System gehen, also steckt der
// HTTP-Teil hier - einmal geschrieben, von zwei Seiten benutzt:
//
//   pi/server.js  liest und schreibt die Konfiguration selbst (kein Electron da)
//   main.js       reicht die Funktionen von Electron herein, damit nicht zwei
//                 Stellen unabhaengig voneinander dieselbe Datei schreiben
//
// Deshalb kennt dieses Modul die Ablage nicht: es bekommt Ordner, lesen() und
// schreiben() uebergeben und kuemmert sich nur um HTTP.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { zeitStatus } = require('./zeitstatus');
const { entgegennehmen, formatHinweis } = require('./hochladen');
const { fotosAufraeumen } = require('./fotos');
const ttDatei = require('./timetabledatei');
const anmeldung = require('./anmeldung');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// Anmeldefenster (captive portal)
// ---------------------------------------------------------------------------
// Jedes Handy fragt nach dem Verbinden still eine feste Adresse ab, ob es
// online ist. Bekommt es statt der erwarteten Antwort eine Weiterleitung, geht
// sein Anmeldefenster mit dem Ziel auf - das ist der ganze Trick. Der dnsmasq
// des Funkzugangs (pi/install.sh) leitet die Namen hierher, wir antworten auf
// die Pfade. Bewusst immer die Weiterleitung, nie "online": so geht das Fenster
// bei jedem neuen Geraet auf.
const PORTAL_PFADE = new Set([
  '/generate_204', '/gen_204',                          // Android, Chrome
  '/hotspot-detect.html', '/library/test/success.html', // iOS, macOS
  '/connecttest.txt', '/ncsi.txt', '/redirect',         // Windows
  '/canonical.html', '/success.txt',                    // Firefox
  '/check_network_status.txt', '/nmcheck.gnome.org',    // GNOME, KDE
  '/kindle-wifi/wifistub.html', '/mobile/status.php'
]);

// Die Helfer, die root brauchen (pi/ap.sh, pi/uhr.sh) - nur auf dem Pi da.
const HELFER = { ap: '/usr/local/bin/bar-display-ap', uhr: '/usr/local/bin/bar-display-uhr' };
function helferDa(name) {
  return process.platform === 'linux' && fs.existsSync(HELFER[name]);
}
function helfer(name, args, eingabe) {
  return new Promise((fertig) => {
    // Der Funkzugang braucht bis zu zwei Minuten, um herunter- und wieder
    // heraufzufahren; die Uhr ist in Sekunden erledigt.
    const frist = name === 'ap' ? 180000 : 45000;
    const kind = execFile('sudo', ['-n', HELFER[name], ...args], { timeout: frist }, (fehler, aus, err) => {
      fertig({ ok: !fehler, aus: String(aus || ''), err: String(err || ''), code: fehler ? fehler.code : 0 });
    });
    if (kind.stdin) { if (eingabe != null) kind.stdin.write(String(eingabe) + '\n'); kind.stdin.end(); }
  });
}

const TYPEN = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
  '.ogv': 'video/ogg', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

// Adressen, unter denen der Dienst im Netz erreichbar ist.
//
// Ein Rechner hat davon schnell mehrere, und die meisten nuetzen an der Bar
// nichts: VPN-Zugaenge, virtuelle Maschinen, WSL. Wer die oben in der Liste
// stehen hat, tippt sie am Handy ab und wundert sich, warum nichts kommt -
// genau so ist es passiert. Deshalb fliegen bekannte virtuelle Anschluesse
// raus, und der Rest wird nach Brauchbarkeit sortiert.
const VIRTUELL = /(vpn|vethernet|virtualbox|vmware|hyper-?v|wsl|tailscale|zerotier|wireguard|nordlynx|mullvad|tap-|tun\d|docker|loopback|bluetooth|pseudo)/i;

// Heimnetze liegen fast immer in 192.168.*; 172.16-31.* und 10.* kommen vor,
// werden aber auch gern von VPN und virtuellen Maschinen benutzt.
function adressRang(ip) {
  if (/^192\.168\./.test(ip)) return 0;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 1;
  if (/^10\./.test(ip)) return 2;
  if (/^169\.254\./.test(ip)) return 4;   // ohne DHCP zugeteilt, meist nutzlos
  return 3;
}

/** Aus einer Schnittstellenliste die brauchbaren Adressen, beste zuerst. */
function adressenAus(netze) {
  const alle = [];
  for (const name of Object.keys(netze || {})) {
    for (const n of netze[name] || []) {
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      if (n.internal) continue;
      alle.push({ ip: n.address, name, virtuell: VIRTUELL.test(name) });
    }
  }

  // Virtuelle nur dann behalten, wenn sonst gar nichts uebrig bliebe - lieber
  // eine unbrauchbare Adresse als gar keine Auskunft.
  const echte = alle.filter(a => !a.virtuell);
  const nehmen = echte.length ? echte : alle;

  return nehmen
    .sort((a, b) => adressRang(a.ip) - adressRang(b.ip))
    .map(a => a.ip);
}

function adressen() {
  return adressenAus(os.networkInterfaces());
}

/**
 * Baut den Dienst. Gestartet wird er vom Aufrufer, der auch den Port bestimmt.
 *
 * ordner    { user, media, photo, brand, font, config }
 * lesen()   liefert die aktuelle Konfiguration
 * schreiben(cfg) speichert und liefert die gespeicherte Fassung zurueck
 * version   Fassungsnummer fuer die Kopfzeile der Einstellungsseite
 */
function erstellen({ ordner, lesen, schreiben, version, srcDir, displays, nummerieren, anzeigegeraet }) {
  const O = ordner;
  const SRC_DIR = srcDir || path.join(__dirname, '..', 'src');

  function ordnerAnlegen() {
    for (const d of [O.media, O.photo, O.brand, O.font]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  const lauscher = new Set();
  const beruehrungen = [];

  function verkuenden(cfg) {
    const nachricht = 'event: config\ndata: ' + JSON.stringify(cfg) + '\n\n';
    for (const res of lauscher) {
      try { res.write(nachricht); } catch (e) { lauscher.delete(res); }
    }
  }

  function ausliefern(res, datei, req) {
    let stat;
    try { stat = fs.statSync(datei); } catch (e) { return fehler(res, 404, 'Nicht gefunden'); }
    if (!stat.isFile()) return fehler(res, 404, 'Nicht gefunden');

    const typ = TYPEN[path.extname(datei).toLowerCase()] || 'application/octet-stream';

    // Videos brauchen Bereichsanfragen, sonst springt der Browser nicht und
    // beginnt bei grossen Dateien erst nach vollstaendigem Laden.
    const bereich = req.headers.range;
    if (bereich) {
      const treffer = /^bytes=(\d*)-(\d*)$/.exec(bereich);
      if (treffer) {
        let von = treffer[1] ? parseInt(treffer[1], 10) : 0;
        let bis = treffer[2] ? parseInt(treffer[2], 10) : stat.size - 1;
        if (isNaN(von) || von < 0) von = 0;
        if (isNaN(bis) || bis >= stat.size) bis = stat.size - 1;
        if (von > bis) return fehler(res, 416, 'Bereich ungueltig');
        res.writeHead(206, {
          'Content-Type': typ,
          'Content-Length': bis - von + 1,
          'Content-Range': 'bytes ' + von + '-' + bis + '/' + stat.size,
          'Accept-Ranges': 'bytes'
        });
        return fs.createReadStream(datei, { start: von, end: bis }).pipe(res);
      }
    }

    res.writeHead(200, {
      'Content-Type': typ,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(datei).pipe(res);
  }

  function fehler(res, code, text) {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
  }

  // Schreiben verlangt die PIN, sofern eine gesetzt ist. Lesen bleibt offen -
  // die Anzeige im Kiosk-Browser kann keine PIN eintippen und braucht die
  // Konfiguration trotzdem.
  function darfSchreiben(req, res) {
    const cfg = lesen();
    if (!(cfg.settings.pin || '').trim()) return true;
    if (anmeldung.angemeldet(req)) return true;
    // Das Bedienfeld auf dem Touch-Bildschirm laeuft im Kiosk-Browser auf dem
    // Geraet selbst - wer davor steht, darf. Eine PIN kann es nicht tippen.
    if (vomGeraet(req)) return true;
    json(res, { ok: false, fehler: 'Bitte erst die PIN eingeben.' }, 401);
    return false;
  }

  // Der Helfer meldet JSON auf stdout; scheitert er, steht der Grund auf stderr.
  function apAntwort(r) {
    try {
      const a = JSON.parse(r.aus.trim().split('\n').pop() || '{}');
      if (!r.ok && !a.fehler) a.fehler = r.err.trim() || 'Der Funkzugang meldete einen Fehler.';
      return Object.assign({ verfuegbar: true }, a);
    } catch (e) {
      return { verfuegbar: true, aktiv: false, fehler: (r.err || r.aus || 'Keine Antwort vom Funkzugang.').trim() };
    }
  }

  function vomGeraet(req) {
    const a = String((req.socket && req.socket.remoteAddress) || '');
    return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  }

  function json(res, daten, code = 200) {
    const koerper = JSON.stringify(daten);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(koerper)
    });
    res.end(koerper);
  }

  // Nur Dateien innerhalb des erlaubten Ordners herausgeben
  function sicherJoin(basis, rest) {
    const ziel = path.join(basis, path.normalize(rest).replace(/^([.][.][\\/])+/, ''));
    const echt = path.resolve(ziel);
    if (echt !== path.resolve(basis) && !echt.startsWith(path.resolve(basis) + path.sep)) return null;
    return echt;
  }

  function koerperLesen(req) {
    return new Promise((resolve, reject) => {
      let daten = '';
      let zuViel = false;
      req.on('data', (stueck) => {
        daten += stueck;
        if (daten.length > 40 * 1024 * 1024) { zuViel = true; req.destroy(); }
      });
      req.on('end', () => zuViel ? reject(new Error('zu gross')) : resolve(daten));
      req.on('error', reject);
    });
  }

  // ---------------------------------------------------------------------------
  // Achtung: nicht "/fonts" verwenden - unter src/fonts liegt die mitgelieferte
  // Josefin Sans, auf die player.css per @font-face verweist. Eine eigene Schrift
  // der Bar wird deshalb unter /eigeneschrift ausgeliefert.

  const ORDNER = {
    '/media': O.media,
    '/photos': O.photo,
    '/branding': O.brand,
    '/eigeneschrift': O.font
  };

  const anfrage = async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const pfad = decodeURIComponent(url.pathname);

    try {
      // Online-Pruefung eines Handys: Weiterleitung auf die Anmeldeseite, unter
      // der Adresse, ueber die die Anfrage hereinkam (Funkzugang oder Kabel).
      if (PORTAL_PFADE.has(pfad)) {
        const ip = String(req.socket.localAddress || '').replace(/^::ffff:/, '');
        const port = req.socket.localPort;
        const ziel = 'http://' + (ip || 'localhost') + (port && port !== 80 ? ':' + port : '') + '/portal';
        res.writeHead(302, { Location: ziel, 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' });
        return res.end('Weiter zu ' + ziel);
      }
      if (pfad === '/portal') {
        return ausliefern(res, path.join(SRC_DIR, 'portal.html'), req);
      }

      if (pfad === '/' || pfad === '/anzeige') {
        return ausliefern(res, path.join(SRC_DIR, 'player.html'), req);
      }
      if (pfad === '/einstellungen') {
        return ausliefern(res, path.join(SRC_DIR, 'settings.html'), req);
      }
      // Das Plakat: der Tagesplan aller Orte auf der hohen Saeule - und die
      // Vorschau dazu mit Reglern, fuer den Aufbau.
      if (pfad === '/plakat') {
        return ausliefern(res, path.join(SRC_DIR, 'plakat.html'), req);
      }
      if (pfad === '/plakat/vorschau' || pfad === '/vorschau') {
        return ausliefern(res, path.join(SRC_DIR, 'plakat-vorschau.html'), req);
      }

      if (pfad === '/api/paths') {
        return json(res, {
          mode: 'http',
          mediaDir: '/media', photoDir: '/photos',
          brandDir: '/branding', fontDir: '/eigeneschrift',
          userDir: O.user, configPath: O.config,
          version: version
        });
      }

      // Unter welcher Adresse ist die Bedienseite erreichbar? Die Anzeige blendet
    // das beim Start kurz ein, damit niemand die IP suchen muss.
    if (pfad === '/api/fern') {
      const s = lesen().settings;
      return json(res, {
        aktiv: true,
        gewuenscht: true,
        hinweis: s.fernHinweis !== false,
        port: (server.address() || {}).port || null,
        adressen: adressen(),
        fehler: ''
      });
    }

    // Bildschirme kennt nur Electron. Auf dem Pi gibt es keine Auswahl, dort
    // bleibt die Liste leer und die Einstellungsseite blendet die Karte aus.
    if (pfad === '/api/displays' && req.method === 'GET') {
      return json(res, typeof displays === 'function' ? displays() : []);
    }

    if (pfad === '/api/displays/nummerieren' && req.method === 'POST') {
      if (!darfSchreiben(req, res)) return;
      const anzahl = typeof nummerieren === 'function' ? nummerieren() : 0;
      return json(res, { anzahl });
    }

    if (pfad === '/api/zeit') {
        // Bewusst await: ein returntes Versprechen laeuft am try/catch vorbei,
        // und eine unbehandelte Ablehnung beendet in Node den ganzen Prozess.
        // Der Dienst wuerde dann bei jeder Zeitabfrage neu starten.
        // stellbar: auf dem Pi laesst sich die Uhr von hier aus stellen (pi/uhr.sh)
        return json(res, Object.assign(await zeitStatus(), { stellbar: helferDa('uhr') }));
      }

      // Der eigene Funkzugang (pi/ap.sh). Ohne Helfer (Rechner, Electron) gibt
      // es ihn nicht, und die Bedienseite blendet die Karte aus.
      if (pfad === '/api/ap' && req.method === 'GET') {
        if (!helferDa('ap')) return json(res, { verfuegbar: false });
        const r = await helfer('ap', ['status']);
        return json(res, apAntwort(r));
      }
      if (pfad === '/api/ap' && req.method === 'POST') {
        if (!darfSchreiben(req, res)) return;
        if (!helferDa('ap')) return json(res, { verfuegbar: false, fehler: 'Auf diesem Geraet gibt es keinen Funkzugang.' }, 400);
        const w = JSON.parse(await koerperLesen(req) || '{}');
        const modus = String(w.modus || 'aus');
        if (!['aus', 'offen', 'wpa2'].includes(modus)) return json(res, { fehler: 'Unbekannter Modus.' }, 400);
        const versteckt = w.versteckt === true || w.versteckt === 'true';
        const ssid = String(w.ssid || '').trim();
        if (modus !== 'aus' && (!ssid || ssid.length > 32)) return json(res, { fehler: 'Name des Funknetzes: 1 bis 32 Zeichen.' }, 400);
        const schluessel = String(w.schluessel || '');
        if (modus === 'wpa2' && (schluessel.length < 8 || schluessel.length > 63)) return json(res, { fehler: 'Passwort: 8 bis 63 Zeichen.' }, 400);
        const args = ['anwenden', modus, ssid]; if (versteckt) args.push('versteckt');
        const r = modus === 'aus' ? await helfer('ap', ['aus']) : await helfer('ap', args, modus === 'wpa2' ? schluessel : '');
        return json(res, apAntwort(r), r.ok ? 200 : 500);
      }

      // Spur der letzten Beruehrungen auf dem Touch-Bildschirm - zum Einrichten
      // aus der Ferne: wo landet ein Tipp im Fenster? Nur vom Geraet selbst.
      if (pfad === '/api/beruehrung' && req.method === 'POST') {
        if (!vomGeraet(req)) return json(res, { ok: false }, 403);
        const b = JSON.parse(await koerperLesen(req) || '{}');
        beruehrungen.push({ t: new Date().toISOString().slice(11, 19), x: Number(b.x), y: Number(b.y), art: String(b.art || '') });
        while (beruehrungen.length > 30) beruehrungen.shift();
        return json(res, { ok: true });
      }
      if (pfad === '/api/beruehrung') return json(res, beruehrungen);

      // Die Uhr stellen - fuer ein Geraet ohne Netz. Sekunden seit 1970.
      if (pfad === '/api/uhr' && req.method === 'POST') {
        if (!darfSchreiben(req, res)) return;
        if (!helferDa('uhr')) return json(res, { ok: false, fehler: 'Auf diesem Geraet laesst sich die Uhr hier nicht stellen.' }, 400);
        const w = JSON.parse(await koerperLesen(req) || '{}');
        let r;
        if (w.ntp) {
          r = await helfer('uhr', ['ntp']);
        } else {
          const sek = Math.round(Number(w.sekunden));
          if (!Number.isFinite(sek) || sek < 1600000000 || sek > 4000000000) return json(res, { ok: false, fehler: 'Unsinnige Zeit.' }, 400);
          r = await helfer('uhr', [String(sek)]);
        }
        return json(res, { ok: r.ok, fehler: r.ok ? '' : (r.err.trim() || 'Uhr liess sich nicht stellen.'), zeit: await zeitStatus() });
      }

      // Die PIN steht in der Konfiguration - wer sie nicht kennt, bekommt sie
      // hier auch nicht zu lesen.
      if (pfad === '/api/config' && req.method === 'GET') {
        const cfg = lesen();
        return json(res, anmeldung.angemeldet(req) ? cfg : anmeldung.ohnePin(cfg));
      }

      if (pfad === '/api/status') {
        const cfg = lesen();
        return json(res, {
          pinAktiv: !!(cfg.settings.pin || '').trim(),
          angemeldet: anmeldung.angemeldet(req)
        });
      }

      if (pfad === '/api/anmelden' && req.method === 'POST') {
        const cfg = lesen();
        const erwartet = (cfg.settings.pin || '').trim();
        if (!erwartet) return json(res, { ok: true, pinAktiv: false });

        const eingabe = JSON.parse(await koerperLesen(req) || '{}').pin;
        if (!anmeldung.pinStimmt(eingabe, erwartet)) {
          return json(res, { ok: false, fehler: 'PIN stimmt nicht.' }, 401);
        }
        res.setHeader('Set-Cookie', anmeldung.cookieKopf(anmeldung.anmelden()));
        return json(res, { ok: true });
      }

      if (pfad === '/api/config' && req.method === 'POST') {
        if (!darfSchreiben(req, res)) return;
        const roh = await koerperLesen(req);
        const neu = JSON.parse(roh);
        const alt = lesen();

        // Hat inzwischen jemand anders gespeichert - am Rechner oder von einem
        // zweiten Handy - baut diese Aenderung auf einer ueberholten Fassung
        // auf. Dann lieber nachfragen als den anderen still ueberschreiben.
        const mitStand = Number(neu.stand);
        const daStand = Number(alt.stand);
        if (Number.isFinite(mitStand) && daStand && mitStand !== daStand) {
          return json(res, { konflikt: true, aktuell: alt }, 409);
        }

        // Wer die Konfiguration ungeschuetzt gelesen hat, bekam sie ohne PIN und
        // mit der Marke pinAktiv. Schickt er sie so zurueck, wuerde die echte PIN
        // stillschweigend verschwinden - also an der Marke erkennen und behalten.
        // Eine bewusst geleerte PIN kommt ohne die Marke, weil sie nur beim
        // Ausblenden gesetzt wird.
        if (neu.settings && neu.settings.pinAktiv && !(neu.settings.pin || '').trim()) {
          neu.settings.pin = alt.settings.pin;
        }
        if (neu.settings) delete neu.settings.pinAktiv;
        const gespeichert = schreiben(neu);
        // Wurde die PIN geaendert, gelten alte Anmeldungen nicht mehr
        if ((gespeichert.settings.pin || '') !== (alt.settings.pin || '')) anmeldung.abmeldenAlle();
        verkuenden(gespeichert);
        return json(res, gespeichert);
      }

      // ---- Datei vom Handy entgegennehmen ---------------------------------
      if (pfad === '/api/upload' && req.method === 'POST') {
        if (!darfSchreiben(req, res)) return;
        const art = url.searchParams.get('art') || '';
        const ordner = { media: O.media, photo: O.photo, logo: O.brand, font: O.font }[art];
        if (!ordner) return json(res, { ok: false, fehler: 'Unbekannte Art.' }, 400);

        ordnerAnlegen();
        try {
          const erg = await entgegennehmen(req, art, url.searchParams.get('name') || '', ordner);
          const hinweis = art === 'media'
            ? formatHinweis(path.join(ordner, erg.name), anzeigegeraet) : null;
          return json(res, { ok: true, file: erg.name, groesse: erg.groesse, hinweis });
        } catch (err) {
          // Meldungen aus hochladen.js sind fuer die Crew gedacht und enthalten
          // keine Pfade. Ein durchgereichter Systemfehler koennte welche
          // enthalten - der bleibt im Protokoll.
          if (err && err.systemfehler) {
            console.error('[upload]', err.systemfehler);
            return json(res, { ok: false, fehler: 'Ablegen fehlgeschlagen.' }, 400);
          }
          return json(res, { ok: false, fehler: (err && err.message) || 'Fehlgeschlagen.' }, 400);
        }
      }

      // ---- Timetable weitergeben und uebernehmen ---------------------------
      // Dieselbe Datei wie am Rechner (lib/timetabledatei.js), damit eine Bar
      // die Datei der anderen lesen kann - egal, wo sie entstanden ist.
      if (pfad === '/api/timetable' && req.method === 'GET') {
        const inhalt = ttDatei.bauen(lesen(), fs, path, O.photo);
        const text = JSON.stringify(inhalt, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(text),
          // Damit das Handy die Datei ablegt, statt sie anzuzeigen
          'Content-Disposition': 'attachment; filename="' + ttDatei.DATEINAME + '"',
          'Cache-Control': 'no-store'
        });
        return res.end(text);
      }

      if (pfad === '/api/timetable' && req.method === 'POST') {
        if (!darfSchreiben(req, res)) return;
        let daten = null;
        try { daten = JSON.parse(await koerperLesen(req)); }
        catch (err) { return json(res, { ok: false, fehler: 'Die Datei ist nicht lesbar.' }, 400); }

        if (!ttDatei.istTimetableDatei(daten)) {
          return json(res, {
            ok: false, fehler: 'Das ist keine weitergegebene Timetable-Datei.'
          }, 400);
        }
        ordnerAnlegen();
        return json(res, { ok: true, entries: ttDatei.uebernehmen(daten, fs, path, O.photo) });
      }

      // ---- Unbenutzte Act-Fotos wegraeumen --------------------------------
      if (pfad === '/api/aufraeumen' && req.method === 'POST') {
        if (!darfSchreiben(req, res)) return;
        ordnerAnlegen();
        const weg = fotosAufraeumen(fs, path, O.photo, lesen());
        return json(res, { ok: true, weg });
      }

      // ---- Datei wieder loeschen ------------------------------------------
      if (pfad === '/api/loeschen' && req.method === 'POST') {
        if (!darfSchreiben(req, res)) return;
        const art = url.searchParams.get('art') || '';
        const ordner = { media: O.media, photo: O.photo, logo: O.brand, font: O.font }[art];
        if (!ordner) return json(res, { ok: false, fehler: 'Unbekannte Art.' }, 400);
        const name = path.basename(String(url.searchParams.get('name') || ''));
        const ziel = path.join(ordner, name);
        if (!name || path.dirname(path.resolve(ziel)) !== path.resolve(ordner)) {
          return json(res, { ok: false, fehler: 'Ungueltiger Name.' }, 400);
        }
        try {
          fs.unlinkSync(ziel);
        } catch (e) {
          // Kein e.message nach draussen: der enthaelt den vollen Pfad
          console.error('[loeschen]', e && e.message);
          return json(res, { ok: false, fehler: 'Datei liess sich nicht loeschen.' }, 400);
        }
        return json(res, { ok: true });
      }

      if (pfad === '/api/media') {
        ordnerAnlegen();
        return json(res, fs.readdirSync(O.media));
      }

      if (pfad === '/api/canconvert') {
        return json(res, false);   // Umwandeln passiert am Rechner, nicht auf dem Pi
      }

      if (pfad === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        res.write('retry: 3000\n\n');
        lauscher.add(res);
        const puls = setInterval(() => { try { res.write(': puls\n\n'); } catch (e) { /* egal */ } }, 25000);
        req.on('close', () => { clearInterval(puls); lauscher.delete(res); });
        return;
      }

      // Medien, Fotos, Logo, Schrift
      for (const [praefix, ordner] of Object.entries(ORDNER)) {
        if (pfad.startsWith(praefix + '/')) {
          const rest = pfad.slice(praefix.length + 1);
          const datei = sicherJoin(ordner, rest);
          if (!datei) return fehler(res, 403, 'Nicht erlaubt');

          // Das mitgelieferte L300-Logo liegt in src/branding, nicht im Ordner der
          // Bar. Ohne diesen Rueckfall zeigt der Player unter Electron das
          // Standardlogo (relativer Pfad ab src/) und am Pi nichts.
          if (!fs.existsSync(datei) && praefix === '/branding') {
            const mitgeliefert = sicherJoin(path.join(SRC_DIR, 'branding'), rest);
            if (mitgeliefert && fs.existsSync(mitgeliefert)) return ausliefern(res, mitgeliefert, req);
          }
          return ausliefern(res, datei, req);
        }
      }

      // alles Übrige aus src/ (player.js, player.css, Schriften, Standardlogo ...)
      const datei = sicherJoin(SRC_DIR, pfad.replace(/^\//, ''));
      if (!datei) return fehler(res, 403, 'Nicht erlaubt');
      return ausliefern(res, datei, req);

    } catch (err) {
      return fehler(res, 500, 'Fehler: ' + err.message);
    }
  };
  const server = http.createServer(anfrage);

  // `anfrage` geht mit hinaus: pi/server.js haengt denselben Dienst noch an
  // Port 80 (Anmeldefenster, Adresse ohne Portnummer).
  return { server, anfrage, verkuenden, ordnerAnlegen };
}

module.exports = { erstellen, adressen, adressenAus, adressRang };
