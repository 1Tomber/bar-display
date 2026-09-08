'use strict';

// "Nett hier." - der Aufkleber.
//
// An jeder Bar ausser der Planetenweide taucht er gelegentlich fuer zwanzig
// Sekunden auf und wirbt fuer sie. Auf der Planetenweide selbst waere das
// albern, dort bleibt er weg - gefragt sind dafuer beide Namensfelder, denn in
// der Vorgabe steht "TARMAC BAR" oben und "Planetenweide" darunter.
//
// Er ist nachgebaut und kein Bild: eine feste viewBox, alles andere rechnet
// der Browser. Deshalb wird hier auch nachgemessen, dass er auf einem
// Hochformat nicht gequetscht wird und ueber keinen Rand haengt.

const { test, expect, beispiel, schleifeMitschreiben } = require('./hilfe/bar');

const MINUTE = 60000;

// Lange Standzeiten mit Absicht: geprueft werden Stunden, und der Aufkleber
// kann ohnehin nur bei einem Seitenwechsel drankommen. Mit drei Sekunden
// Standzeit waeren sechs Stunden ueber siebentausend Wechsel - das dauert
// laenger als der Test darf und misst nichts Zusaetzliches.
const STAND_S = 300;

// Anderthalb Stunden. Der erste Auftritt faellt zwischen die zwanzigste und
// die achtzigste Minute, egal wie der Wuerfel fiel - in diesem Fenster muss er
// also gekommen sein, und wo er wegbleiben soll, bleibt er es auch. Laenger
// laufen zu lassen brauchte nichts und kostet spuerbar: jede gefaelschte
// Sekunde ruft die Uhr der Anzeige auf.
const FENSTER = 90 * MINUTE;

function programm(namen, zusatz) {
  return beispiel(Object.assign({
    settings: Object.assign({
      timetableEvery: 1, timetableDuration: STAND_S,
      pricesEvery: 0, lichtEvery: 0
    }, namen),
    prices: []
  }, zusatz || {}));
}

/** Fremde Bar: hier soll er kommen. */
const FREMD = { barName: 'Hangar-Bar', subtitle: 'by L300' };

async function anzeige(page, bar, namen) {
  bar.konfig(programm(namen || FREMD));
  await page.clock.install();
  const spur = schleifeMitschreiben(page);
  await page.goto(bar.adresse + '/');
  await page.waitForSelector('.slide[data-kind]');
  return spur;
}

test.describe('Wann er kommt', () => {
  test('nach einer Weile taucht er auf', async ({ page, bar }) => {
    const spur = await anzeige(page, bar);

    // Der Zeitpunkt wird gewuerfelt: zwanzig bis achtzig Minuten nach dem
    // Start. Nach neunzig Minuten muss er also gelaufen sein, egal wie der
    // Wuerfel fiel.
    await page.clock.runFor(FENSTER);
    expect(spur.filter(x => x === 'nett').length,
      'einmal innerhalb der ersten anderthalb Stunden').toBeGreaterThan(0);
  });

  test('in den ersten zwanzig Minuten nicht', async ({ page, bar }) => {
    // Wer die Anzeige beim Aufbau kurz laufen laesst, soll ihn nicht sehen.
    const spur = await anzeige(page, bar);

    // Der Wuerfel wird auf null gestellt: das ist der frueheste Zeitpunkt, den
    // es ueberhaupt geben kann. Ohne das prueft der Test nichts - mit
    // ausgebautem Vorlauf faellt der Wurf in zwei von drei Laeufen trotzdem
    // hinter die neunzehnte Minute, und der Test waere gruen.
    await page.evaluate(() => { nettPlan = nettErster(Date.now(), () => 0); });

    await page.clock.runFor(19 * MINUTE);
    expect(spur.filter(x => x === 'nett'),
      'neunzehn Minuten nach dem Start noch nichts').toEqual([]);

    // Gegenprobe im selben Lauf: kurz danach kommt er sehr wohl. Sonst koennte
    // die Zeile darueber auch dann gruen sein, wenn er nie kaeme.
    await page.clock.runFor(11 * MINUTE);
    expect(spur.filter(x => x === 'nett').length,
      'nach einer halben Stunde aber schon').toBe(1);
  });

  test('er zerreisst keine mehrseitige Karte', async ({ page, bar }) => {
    // Er steht im Ablauf hinter dem Nachschlag. Kaeme er davor, stuende er
    // mitten zwischen Seite 1 und Seite 2 der Getraenkekarte.
    bar.konfig(programm(FREMD, {
      // Die Namen muessen mit: das zweite Argument ersetzt den settings-Block,
      // und ohne sie stuende hier wieder die Vorgabe mit "Planetenweide".
      settings: Object.assign({ pricesEvery: 1, pricesDuration: STAND_S,
                                pricesProSeite: 1, timetableEvery: 0 }, FREMD),
      prices: [
        { id: 'g1', category: 'Bier', items: [{ id: 'i1', name: 'Pils', price: '4,00' }] },
        { id: 'g2', category: 'Shots', items: [{ id: 'i2', name: 'Feigling', price: '2,00' }] },
        { id: 'g3', category: 'Kaffee', items: [{ id: 'i3', name: 'Espresso', price: '2,50' }] }
      ]
    }));
    await page.clock.install();
    const spur = schleifeMitschreiben(page);
    await page.goto(bar.adresse + '/');
    await page.waitForSelector('.slide[data-kind]');
    await page.clock.runFor(FENSTER);

    expect(spur.filter(x => x === 'nett').length,
      'er ist ueberhaupt gelaufen').toBeGreaterThan(0);

    // Jede Karte besteht aus drei Seiten am Stueck. Steht "nett" dazwischen,
    // findet sich irgendwo eine Folge prices,nett statt prices,prices,prices.
    for (let i = 0; i < spur.length - 1; i++) {
      if (spur[i] !== 'nett') continue;
      const davor = spur.slice(0, i).filter(x => x === 'prices').length;
      expect(davor % 3, 'er faellt nicht in eine angefangene Karte').toBe(0);
    }
  });
});

test.describe('Wo er wegbleibt', () => {
  test('auf der Planetenweide gar nicht', async ({ page, bar }) => {
    const spur = await anzeige(page, bar,
      { barName: 'PLANETENWEIDE', subtitle: '' });
    await page.clock.runFor(FENSTER);
    expect(spur.filter(x => x === 'nett')).toEqual([]);
  });

  test('auch wenn der Name nur im Untertitel steht', async ({ page, bar }) => {
    // Der Vorgabefall: oben "TARMAC BAR", darunter "Planetenweide". Wer nur
    // das obere Feld pruefte, haenge den Aufkleber ausgerechnet an die Bar,
    // fuer die er wirbt.
    const spur = await anzeige(page, bar,
      { barName: 'TARMAC BAR', subtitle: 'Planetenweide' });
    await page.clock.runFor(FENSTER);
    expect(spur.filter(x => x === 'nett')).toEqual([]);
  });

  test('auch in der Schreibweise "Planetweide"', async ({ page, bar }) => {
    const spur = await anzeige(page, bar,
      { barName: 'planet-weide', subtitle: '' });
    await page.clock.runFor(FENSTER);
    expect(spur.filter(x => x === 'nett')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wie er aussieht
// ---------------------------------------------------------------------------

/** Zeigt den Aufkleber sofort, ohne eine Stunde zu warten. */
async function jetztZeigen(page, bar, namen, masse) {
  bar.konfig(programm(namen || FREMD));
  if (masse) await page.setViewportSize(masse);
  await page.goto(bar.adresse + '/');
  await page.waitForSelector('.slide[data-kind]');

  // nettPlan ist eine Variable des Player-Skripts; ein top-level let liegt im
  // globalen lexikalischen Bereich und ist von hier aus erreichbar.
  await page.evaluate(() => { nettPlan = Date.now(); advance(); });
  await page.waitForSelector('.layer.show .nettWrap');
  await page.evaluate(() => document.fonts && document.fonts.ready);
}

test.describe('Wie er aussieht', () => {
  for (const [name, masse] of Object.entries({
    'Breitbild 1920x1080': { width: 1920, height: 1080 },
    'kleines Brett 1024x600': { width: 1024, height: 600 },
    'Hochformat 1080x1920': { width: 1080, height: 1920 },
    'fast quadratisch 1280x1024': { width: 1280, height: 1024 }
  })) {
    test('passt aufs ' + name, async ({ page, bar }) => {
      await jetztZeigen(page, bar, null, masse);

      const lage = await page.evaluate(() => {
        const svg = document.querySelector('.layer.show .nettBild');
        const b = svg.getBBox ? svg.getBoundingClientRect() : null;
        const buehne = document.getElementById('stage').getBoundingClientRect();
        // Was wirklich gezeichnet wird, ist die Ellipse - das <svg> selbst
        // fuellt die Flaeche, preserveAspectRatio laesst daneben Luft.
        const e = svg.querySelector('.nettRund').getBoundingClientRect();
        return {
          breite: e.width, hoehe: e.height,
          links: e.left - buehne.left, rechts: buehne.right - e.right,
          oben: e.top - buehne.top, unten: buehne.bottom - e.bottom
        };
      });

      expect(lage.breite / lage.hoehe, 'die Form bleibt, nichts wird gequetscht')
        .toBeCloseTo(1024 / 658, 2);
      for (const seite of ['links', 'rechts', 'oben', 'unten']) {
        expect(lage[seite], 'kein Ueberhang ' + seite).toBeGreaterThanOrEqual(-1);
      }
      expect(Math.min(lage.breite, lage.hoehe),
        'und er ist gross genug, um ihn zu lesen').toBeGreaterThan(120);
    });
  }

  test('die Schrift bleibt im Aufkleber', async ({ page, bar }) => {
    // textLength haelt die Zeilen auf ihrer Breite - sonst haengt die lange
    // Zeile auf einem Rechner ohne Playfair ueber den gelben Rand hinaus.
    await jetztZeigen(page, bar, null, { width: 1920, height: 1080 });

    const raus = await page.evaluate(() => {
      const svg = document.querySelector('.layer.show .nettBild');
      const e = svg.querySelector('.nettRund').getBoundingClientRect();
      const schlimm = [];
      svg.querySelectorAll('text').forEach((t) => {
        const r = t.getBoundingClientRect();
        // Waagerecht in der Ellipse: auf ihrer Hoehe ist sie schmaler als ihre
        // volle Breite, deshalb wird gegen die Ellipsenformel geprueft.
        const cx = e.left + e.width / 2, cy = e.top + e.height / 2;
        const dy = (r.top + r.height / 2 - cy) / (e.height / 2);
        const halb = (e.width / 2) * Math.sqrt(Math.max(0, 1 - dy * dy));
        const raum = 2 * halb;
        if (r.width > raum) schlimm.push(t.textContent + ': ' +
          Math.round(r.width) + ' breit, Platz ' + Math.round(raum));
      });
      return schlimm;
    });
    expect(raus).toEqual([]);
  });

  test('der QR-Code steht richtig herum', async ({ page, bar }) => {
    // Der Pfad wird von Hand aus der Modulmatrix gebaut. Waeren dabei Zeile
    // und Spalte vertauscht, ergaebe das einen tadellos aussehenden, aber
    // falschen Code - und den merkt man erst, wenn ihn jemand scannt.
    await jetztZeigen(page, bar, null, { width: 1920, height: 1080 });

    const vergleich = await page.evaluate((ziel) => {
      const q = qrcode(0, 'M');
      q.addData(ziel);
      q.make();
      const n = q.getModuleCount();

      const pfad = document.querySelector('.layer.show .nettBild g path');
      const kasten = pfad.getBoundingClientRect();
      // Der Pfad umfasst nur die dunklen Module - links und oben liegt bei
      // jedem QR-Code eine volle Ecke, der Kasten beginnt also am Raster.
      const f = kasten.width / n;

      let gleich = 0, anders = 0;
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          const x = kasten.left + (c + 0.5) * f;
          const y = kasten.top + (r + 0.5) * f;
          // SVG trifft nur, wo tatsaechlich gefuellt ist
          const dunkel = document.elementFromPoint(x, y) === pfad;
          if (dunkel === q.isDark(r, c)) gleich++; else anders++;
        }
      }
      return { n, gleich, anders };
    }, 'https://linktr.ee/l300decart');

    expect(vergleich.anders,
      'jedes Modul sitzt da, wo die Bibliothek es hinrechnet').toBe(0);
    expect(vergleich.gleich).toBe(vergleich.n * vergleich.n);
  });

  test('der Rueckfall aufs Bild funktioniert auch', async ({ page, bar }) => {
    // NETT_ALS_BILD schaltet vom Nachbau auf die freigestellte Originaldatei
    // um. Ohne diesen Test waere das ein Weg, den nie jemand geht - und der
    // dann an dem Tag klemmt, an dem er gebraucht wird.
    await jetztZeigen(page, bar, null, { width: 1920, height: 1080 });

    const bild = await page.evaluate(async () => {
      NETT_ALS_BILD = true;
      const ebene = document.querySelector('.layer.show');
      ebene.innerHTML = renderSlide('nett');
      NETT_ALS_BILD = false;

      const img = ebene.querySelector('img.nettBild');
      if (!img) return { da: false };
      if (!img.complete) {
        await new Promise(r => { img.onload = r; img.onerror = r; });
      }
      const r = img.getBoundingClientRect();
      return { da: true, geladen: img.naturalWidth > 0,
               breite: img.naturalWidth, hoehe: img.naturalHeight,
               passend: getComputedStyle(img).objectFit,
               ueberBuehne: r.width <= window.innerWidth + 1 };
    });

    expect(bild.da, 'statt des SVG steht ein Bild da').toBe(true);
    expect(bild.geladen, 'und die Datei ist wirklich angekommen').toBe(true);
    expect(bild.breite / bild.hoehe, 'dieselbe Form wie der Nachbau')
      .toBeCloseTo(1024 / 658, 2);
    expect(bild.passend, 'auch das Bild wird nicht gequetscht').toBe('contain');
    expect(bild.ueberBuehne).toBe(true);
  });

  test('er steht zwanzig Sekunden', async ({ page, bar }) => {
    bar.konfig(programm(FREMD));
    await page.clock.install();
    await page.goto(bar.adresse + '/');
    await page.waitForSelector('.slide[data-kind]');
    await page.evaluate(() => { nettPlan = Date.now(); advance(); });
    await expect(page.locator('.layer.show .nettWrap')).toBeVisible();

    await page.clock.runFor(19000);
    await expect(page.locator('.layer.show .nettWrap'),
      'nach neunzehn Sekunden steht er noch').toBeVisible();

    await page.clock.runFor(2000);
    await expect(page.locator('.layer.show .nettWrap'),
      'nach einundzwanzig ist er weg').toHaveCount(0);
  });
});
