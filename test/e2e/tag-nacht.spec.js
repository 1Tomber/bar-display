'use strict';

// Tag und Nacht: die Anzeige wechselt zwischen zwei Farbsaetzen - nach
// Sonnenstand, zu festen Uhrzeiten oder von Hand. Ausgeschaltet bleibt alles,
// wie es vorher war; das ist der Punkt, den der erste Test festhaelt.
//
// Die Rechnung selbst ist in test/schedule.test.js geprueft. Hier geht es
// darum, dass sie auf der Anzeige und der Bedienseite auch ankommt.

const { test, expect, beispiel } = require('./hilfe/bar');

const TAG = '#450b6f';
const NACHT = '#12141a';

// 2026-08-28 ist ein Freitag
const um = (h, m) => new Date(2026, 7, 28, h, m, 0).getTime();

function programm(settings) {
  return beispiel({
    settings: Object.assign({ bgColor: TAG, bgColorNacht: NACHT,
                              timetableEvery: 1, timetableDuration: 200, pricesEvery: 0 },
                            settings || {})
  });
}

async function zeigt(page, tageszeit) {
  await expect(page.locator('body')).toHaveAttribute('data-tageszeit', tageszeit);
  const farbe = await page.evaluate(
    () => document.documentElement.style.getPropertyValue('--bg'));
  expect(farbe).toBe(tageszeit === 'nacht' ? NACHT : TAG);
}

test.describe('Auf der Anzeige', () => {
  test('ausgeschaltet bleibt es bei den Tagfarben - auch mitten in der Nacht',
    async ({ page, bar }) => {
      bar.konfig(programm({ tagNacht: 'aus' }));
      await page.clock.install({ time: um(3, 0) });
      await page.goto(bar.adresse + '/');
      await zeigt(page, 'tag');
    });

  test('eine alte Konfiguration ohne die neuen Felder zeigt die Tagfarben',
    async ({ page, bar }) => {
      bar.konfig(beispiel({ settings: { bgColor: TAG } }));
      await page.clock.install({ time: um(3, 0) });
      await page.goto(bar.adresse + '/');
      await zeigt(page, 'tag');
    });

  test('feste Zeiten: die Anzeige schaltet zur eingestellten Uhrzeit von selbst um',
    async ({ page, bar }) => {
      bar.konfig(programm({ tagNacht: 'fest', tagVon: '07:00', tagBis: '20:00' }));
      await page.clock.install({ time: um(19, 59) });
      await page.goto(bar.adresse + '/');
      await zeigt(page, 'tag');

      // Niemand speichert, niemand laedt neu - nur die Uhr laeuft weiter
      await page.clock.runFor(90000);
      await zeigt(page, 'nacht');
    });

  test('feste Zeiten: morgens geht es zurueck auf die Tagfarben', async ({ page, bar }) => {
    bar.konfig(programm({ tagNacht: 'fest', tagVon: '07:00', tagBis: '20:00' }));
    await page.clock.install({ time: um(6, 59) });
    await page.goto(bar.adresse + '/');
    await zeigt(page, 'nacht');

    await page.clock.runFor(90000);
    await zeigt(page, 'tag');
  });

  test('von Hand: die Stellung gilt, egal wie spaet es ist', async ({ page, bar }) => {
    bar.konfig(programm({ tagNacht: 'hand', tagNachtHand: 'nacht' }));
    await page.clock.install({ time: um(12, 0) });
    await page.goto(bar.adresse + '/');
    await zeigt(page, 'nacht');

    // Umgestellt wird von der Bedienseite aus - die Anzeige folgt ohne Neuladen
    bar.konfig({ settings: { tagNachtHand: 'tag' } });
    await zeigt(page, 'tag');
  });

  // Berlin zur Sommersonnenwende: Aufgang 02:43 UTC, Untergang 19:33 UTC. Feste
  // Zeitpunkte in UTC, damit der Test ueberall dasselbe prueft. Dass die Anzeige
  // von selbst umschaltet, halten die Tests mit festen Zeiten oben schon fest -
  // hier geht es nur darum, dass der Sonnenstand richtig ankommt.
  for (const [wann, stunde, erwartet] of [['vor Sonnenaufgang', 2, 'nacht'],
                                          ['nach Sonnenaufgang', 3, 'tag'],
                                          ['vor Sonnenuntergang', 19, 'tag'],
                                          ['nach Sonnenuntergang', 20, 'nacht']]) {
    test('Sonnenstand: Berlin zur Sommersonnenwende, ' + wann, async ({ page, bar }) => {
      bar.konfig(programm({ tagNacht: 'astro', astroBreite: '52,52', astroLaenge: '13,405' }));
      await page.clock.install({ time: Date.UTC(2026, 5, 21, stunde, stunde === 19 ? 0 : 15, 0) });
      await page.goto(bar.adresse + '/');
      await zeigt(page, erwartet);
    });
  }

  test('Sonnenstand: der Versatz verschiebt die Umschaltung', async ({ page, bar }) => {
    // 19:00 UTC liegt eine gute halbe Stunde vor dem Untergang - mit einer
    // Stunde Vorlauf gelten schon die Nachtfarben.
    bar.konfig(programm({ tagNacht: 'astro', astroBreite: '52.52', astroLaenge: '13.405',
                          astroVersatzUnter: -60 }));
    await page.clock.install({ time: Date.UTC(2026, 5, 21, 19, 0, 0) });
    await page.goto(bar.adresse + '/');
    await zeigt(page, 'nacht');
  });

  test('Sonnenstand ohne Standort: im Zweifel Tag', async ({ page, bar }) => {
    bar.konfig(programm({ tagNacht: 'astro', astroBreite: '', astroLaenge: '' }));
    await page.clock.install({ time: um(3, 0) });
    await page.goto(bar.adresse + '/');
    await zeigt(page, 'tag');
  });

  test('mit einer Probezeit laesst sich die Nacht am Nachmittag ansehen',
    async ({ page, bar }) => {
      bar.konfig(programm({ tagNacht: 'fest', tagVon: '07:00', tagBis: '20:00',
                            zeitVersatz: 8 * 3600 * 1000 }));
      await page.clock.install({ time: um(14, 0) });
      await page.goto(bar.adresse + '/');
      // Fuer die Anzeige ist es 22 Uhr
      await zeigt(page, 'nacht');
    });
});

test.describe('Auf der Bedienseite', () => {
  async function karte(page, bar) {
    await page.goto(bar.adresse + '/einstellungen');
    await page.getByRole('button', { name: 'Anzeige', exact: true }).click();
  }

  test('die Karte zeigt nur die Felder der gewaehlten Art', async ({ page, bar }) => {
    bar.konfig(programm({ tagNacht: 'aus' }));
    await karte(page, bar);

    for (const id of ['#tnAstro', '#tnFest', '#tnHand', '#tnFarben']) {
      await expect(page.locator(id)).toBeHidden();
    }

    await page.locator('#s_tagNacht').selectOption('astro');
    await expect(page.locator('#tnAstro')).toBeVisible();
    await expect(page.locator('#tnFest')).toBeHidden();
    await expect(page.locator('#tnFarben')).toBeVisible();

    await page.locator('#s_tagNacht').selectOption('fest');
    await expect(page.locator('#tnFest')).toBeVisible();
    await expect(page.locator('#tnAstro')).toBeHidden();

    await page.locator('#s_tagNacht').selectOption('hand');
    await expect(page.locator('#tnHand')).toBeVisible();
    await expect(page.locator('#tnFest')).toBeHidden();
  });

  test('beim Sonnenstand steht da, wann heute umgeschaltet wird', async ({ page, bar }) => {
    bar.konfig(programm({ tagNacht: 'astro' }));
    await karte(page, bar);
    await expect(page.locator('#tnStatus')).toContainText('Noch kein gültiger Standort');

    // Mit Komma, wie man es aus einer deutschen Kartenanwendung abtippt
    await page.locator('#s_astroBreite').fill('52,52');
    await page.locator('#s_astroLaenge').fill('13,405');
    await expect(page.locator('#tnStatus'))
      .toHaveText(/Heute Tagfarben von \d\d:\d\d bis \d\d:\d\d\. Gerade: (Tag|Nacht)\./);
  });

  test('der Handschalter speichert direkt und stellt die Anzeige um',
    async ({ page, bar, context }) => {
      bar.konfig(programm({ tagNacht: 'hand', tagNachtHand: 'tag' }));
      const anzeige = await context.newPage();
      await anzeige.goto(bar.adresse + '/');
      await zeigt(anzeige, 'tag');

      await karte(page, bar);
      await page.locator('#tnHandNacht').click();

      expect(bar.lies().settings.tagNachtHand).toBe('nacht');
      await zeigt(anzeige, 'nacht');
      await expect(page.locator('#tnStatus')).toHaveText('Gerade: Nacht.');
    });

  test('die Uhrzeitfelder zeigen beim Laden, was gespeichert ist', async ({ page, bar }) => {
    // Das Textfeld vor dem eingebauten Zeitfeld bekam von gesetzten Werten
    // nichts mit und blieb leer - auch bei der Ruhezeit, die es schon laenger gibt.
    bar.konfig(programm({ tagNacht: 'fest', tagVon: '06:30', tagBis: '21:15' }));
    bar.konfig({ quiet: { enabled: true, from: '04:00', to: '14:00' } });
    await karte(page, bar);

    const textVor = (id) => page.locator(id).locator('xpath=..').locator('.feldText');
    await expect(textVor('#s_tagVon')).toHaveValue('06:30');
    await expect(textVor('#s_tagBis')).toHaveValue('21:15');
    await expect(textVor('#q_from')).toHaveValue('04:00');
    await expect(textVor('#q_to')).toHaveValue('14:00');
  });
});
