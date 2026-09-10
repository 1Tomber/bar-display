'use strict';

// Speichern vom Handy - und was passiert, wenn es nicht klappt.
//
// Gemeldet am Festivaltag: die Bedienseite war im WLAN erreichbar, aber
// Speichern tat nichts. Kein Hinweis, keine Meldung, der Knopf schien tot.
//
// Der Grund war nicht das Netz, sondern die Stille: saveConfig() warf bei jeder
// Antwort ausser 200 und 409 eine Ausnahme, die niemand fing. Am haeufigsten
// ist das die 401 - die Anmeldung liegt nur im Arbeitsspeicher des Dienstes,
// nach einem Neustart (etwa weil eine neue Fassung installiert wurde) ist sie
// weg. Aus Sicht der Crew: es geht einfach nicht mehr.

const { test, expect, beispiel } = require('./hilfe/bar');

async function bedienseite(page, bar, zusatz) {
  bar.konfig(beispiel(zusatz || {}));
  await page.goto(bar.adresse + '/einstellungen');
  await page.getByRole('button', { name: 'Anzeige', exact: true }).click();
  await expect(page.locator('#s_barName')).toBeVisible();
}

const speichern = (page) => page.getByRole('button', { name: 'Speichern' }).click();

test('geht das Speichern schief, steht es auf dem Schirm', async ({ page, bar }) => {
  await bedienseite(page, bar);

  // Das Netz faellt zwischen Handy und Bar-Rechner aus - beim Aufbau der
  // Normalfall, wenn jemand den Hotspot umschaltet.
  await page.route('**/api/config', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue());

  await page.locator('#s_barName').fill('Hangar-Bar');
  await speichern(page);

  await expect(page.locator('#toast')).toContainText('Speichern fehlgeschlagen');
  await expect(page.locator('#toast')).toHaveClass(/err/);
  await expect(page.locator('#dirty'),
    'und die Aenderung gilt weiter als ungesichert').toBeVisible();
});

test('ohne Fehler bleibt es beim gewohnten Hinweis', async ({ page, bar }) => {
  // Gegenprobe: der uebliche Weg soll sich nicht geaendert haben.
  await bedienseite(page, bar);
  await page.locator('#s_barName').fill('Hangar-Bar');
  await speichern(page);

  await expect(page.locator('#toast')).toContainText('Gespeichert');
  await expect(page.locator('#dirty')).toBeHidden();
  expect(bar.lies().settings.barName).toBe('Hangar-Bar');
});

test('ist die Anmeldung weg, fragt die Seite die PIN neu ab',
  async ({ page, bar }) => {
    // Die Seite wurde ohne PIN geladen. Dann verlangt der Dienst auf einmal
    // eine - so sieht es aus, wenn er neu gestartet wurde und die Anmeldung
    // von vorhin nicht mehr kennt.
    await bedienseite(page, bar);
    page.on('dialog', (d) => d.accept());   // die Rueckfrage zum Ueberschreiben
    bar.konfig({ settings: { pin: '2468' } });

    await page.locator('#s_barName').fill('Hangar-Bar');
    await speichern(page);

    await expect(page.locator('#pinSchirm'),
      'statt stillschweigend nichts zu tun').toBeVisible();

    await page.locator('#pinFeld').fill('2468');
    await page.getByRole('button', { name: 'Weiter' }).click();

    await expect(page.locator('#toast')).toContainText('Gespeichert');
    expect(bar.lies().settings.barName).toBe('Hangar-Bar');
  });

test('die getippten Aenderungen ueberleben die PIN-Abfrage',
  async ({ page, bar }) => {
    // Die PIN-Abfrage beim Oeffnen der Seite holt anschliessend die ganze
    // Konfiguration nach. Mitten im Speichern waere das falsch: es wuerfe
    // genau das weg, was gerade gesichert werden soll.
    await bedienseite(page, bar);
    page.on('dialog', (d) => d.accept());
    bar.konfig({ settings: { pin: '2468' } });

    await page.locator('#s_barName').fill('Hangar-Bar');
    await page.locator('#s_subtitle').fill('by L300');
    await speichern(page);

    await expect(page.locator('#pinSchirm')).toBeVisible();
    await page.locator('#pinFeld').fill('2468');
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(page.locator('#toast')).toContainText('Gespeichert');

    const cfg = bar.lies();
    expect(cfg.settings.barName).toBe('Hangar-Bar');
    expect(cfg.settings.subtitle).toBe('by L300');
    expect(cfg.settings.pin, 'und die PIN steht noch').toBe('2468');
  });

test('eine falsche PIN meldet sich, statt stumm zu bleiben',
  async ({ page, bar }) => {
    await bedienseite(page, bar);
    page.on('dialog', (d) => d.accept());
    bar.konfig({ settings: { pin: '2468' } });

    await page.locator('#s_barName').fill('Hangar-Bar');
    await speichern(page);
    await expect(page.locator('#pinSchirm')).toBeVisible();

    await page.locator('#pinFeld').fill('1111');
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(page.locator('#pinSchirm .pinFehler')).toContainText('stimmt nicht');
  });
