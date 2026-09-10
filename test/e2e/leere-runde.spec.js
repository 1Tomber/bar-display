'use strict';

// "Noch keine Inhalte", obwohl alles gepflegt ist.
//
// Gemeldet am Festivaltag: Lineup und Preise liefen sauber durch, doch sobald
// ein Video dazukam, stand auf dem Bildschirm der Leerlauf-Hinweis.
//
// Zwei Fehler, eine Ursache. buildPlaylist() fragt fuer jeden Eintrag der Runde
// nachDerUhr() - auch fuer ein Video. infoFelder() kennt aber nur Timetable und
// Karte und faellt fuer alles andere auf die Lichtseite zurueck. Stand die auf
// Minuten, galt das damit heimlich fuer jedes Video, und es flog aus der Runde.
// Standen Timetable und Karte ebenfalls auf Minuten, blieb gar nichts uebrig -
// und eine leere Runde ist der Leerlauf.

const { test, expect, beispiel, schleifeMitschreiben } = require('./hilfe/bar');

const NACH_MINUTEN = {
  timetableEinheit: 'minuten', timetableEvery: 10,
  pricesEinheit: 'minuten', pricesEvery: 10,
  lichtEinheit: 'minuten', lichtEvery: 10
};

function programm(extra) {
  return beispiel({
    settings: Object.assign({ timetableDuration: 20, pricesDuration: 20 }, extra),
    videos: []
  });
}

/** Ein Video dazu - so, wie es beim Speichern aus der Bedienseite ankommt. */
function videoDazu(bar) {
  bar.datei('media', 'Cyberflower.mp4');
  bar.konfig({ videos: [{ id: 'v1', file: 'Cyberflower.mp4', title: 'Cyberflower',
                          enabled: true, always: true, windows: [] }] });
}

const runde = (page) => page.evaluate(() => ({
  playlist: playlist.map(i => i.type),
  zeigt: document.querySelector('.layer.show')
    ? document.querySelector('.layer.show').dataset.kind : null
}));

test('mit Haeufigkeit in Minuten bleibt das Video in der Runde',
  async ({ page, bar }) => {
    bar.konfig(programm(NACH_MINUTEN));
    await page.goto(bar.adresse + '/');
    await page.waitForSelector('.slide[data-kind]');

    videoDazu(bar);
    await expect.poll(async () => (await runde(page)).playlist,
      { message: 'das Video steht in der Runde' }).toContain('video');
  });

test('und der Leerlauf-Hinweis kommt nicht', async ({ page, bar }) => {
  // Die eigentliche Meldung. Sichtbar wurde sie erst, als alle drei Seiten
  // nach der Uhr liefen - dann blieb nach dem Aussortieren nichts uebrig.
  bar.konfig(programm(NACH_MINUTEN));
  const spur = schleifeMitschreiben(page);
  await page.goto(bar.adresse + '/');
  await page.waitForSelector('.slide[data-kind]');

  videoDazu(bar);
  await page.waitForTimeout(3000);

  expect(spur, 'kein Leerlauf in der Schleife').not.toContain('idle');
  expect((await runde(page)).zeigt, 'und auch nichts Leeres auf dem Schirm')
    .not.toBe('idle');
});

test('die Runde wird nie leer', async ({ page, bar }) => {
  // Der Sicherheitsgurt: was auch immer eingestellt ist, es bleibt etwas
  // uebrig. Eine Zahl in einem Haeufigkeitsfeld darf keinen leeren Bildschirm
  // ergeben koennen.
  bar.konfig(programm(NACH_MINUTEN));
  await page.goto(bar.adresse + '/');
  await page.waitForSelector('.slide[data-kind]');
  videoDazu(bar);
  await page.waitForTimeout(1500);

  const leer = await page.evaluate(() => {
    // Alle denkbaren Kombinationen der drei Haeufigkeiten durchspielen
    const merk = JSON.parse(JSON.stringify(cfg.settings));
    const schlimm = [];
    for (const tt of ['beitraege', 'minuten']) {
      for (const pr of ['beitraege', 'minuten']) {
        for (const li of ['beitraege', 'minuten']) {
          Object.assign(cfg.settings, {
            timetableEinheit: tt, pricesEinheit: pr, lichtEinheit: li,
            timetableEvery: 10, pricesEvery: 10, lichtEvery: 10
          });
          buildPlaylist();
          if (!playlist.length) schlimm.push(tt + '/' + pr + '/' + li);
        }
      }
    }
    cfg.settings = merk;
    buildPlaylist();
    return schlimm;
  });
  expect(leer).toEqual([]);
});

test('Beitraege statt Minuten laeuft weiter wie bisher', async ({ page, bar }) => {
  // Gegenprobe: der uebliche Fall darf sich nicht geaendert haben. Nach der
  // Uhr laufende Seiten gehoeren weiterhin aus der Runde heraus, sie kommen
  // ueber die Uhr dazwischen - siehe advance().
  bar.konfig(programm({ timetableEvery: 3, pricesEvery: 3, lichtEvery: 0 }));
  await page.goto(bar.adresse + '/');
  await page.waitForSelector('.slide[data-kind]');
  videoDazu(bar);

  await expect.poll(async () => (await runde(page)).playlist)
    .toEqual(['video', 'timetable', 'prices']);
});

test('nur die Karte nach der Uhr: sie faellt heraus, das Video nicht',
  async ({ page, bar }) => {
    bar.konfig(programm({ timetableEvery: 3, pricesEinheit: 'minuten',
                          pricesEvery: 10, lichtEvery: 0 }));
    await page.goto(bar.adresse + '/');
    await page.waitForSelector('.slide[data-kind]');
    videoDazu(bar);

    await expect.poll(async () => (await runde(page)).playlist)
      .toEqual(['video', 'timetable']);
  });
