'use strict';

// Die Vorschau zum Plakat: alle Tage nebeneinander, oben die Regler.
// Nichts davon erscheint auf der Anzeige - Werkzeug fuer den Aufbau.
(function () {
  let cfg = null;
  const $ = (id) => document.getElementById(id);

  // Beginn eines Tages = fruehester Start seiner Acts; der Regler zaehlt Minuten ab da
  function tagesBeginn(datum) {
    const starts = (cfg.timetable || []).filter(e => e.date === datum).map(e => toMinutes(e.start)).filter(x => x !== null);
    return starts.length ? Math.min(...starts) : 12 * 60;
  }

  function zeichnen() {
    if (!cfg) return;
    const offset = Number($('vsOffset').value);
    $('vsOffsetWert').textContent = offset + ' min';
    const modus = $('vsModus').value;
    const genre = $('vsGenre').checked;
    const live = $('vsLive').checked;
    $('vsOffset').disabled = live;
    const tage = plakatTage(cfg.timetable);
    const wurzel = $('vsTage');
    wurzel.innerHTML = '';
    if (!tage.length) { wurzel.innerHTML = '<p style="color:#fff">Noch keine Acts eingetragen.</p>'; return; }
    for (const datum of tage) {
      const m = datum.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      let jetzt;
      if (live) jetzt = new Date(Date.now() + zeitVersatz(cfg.settings));
      else { const min = tagesBeginn(datum) + offset; jetzt = new Date(+m[1], +m[2] - 1, +m[3], Math.floor(min / 60), min % 60, 0, 0); }
      const nacht = modus === 'auto' ? undefined : modus === 'nacht';
      const html = plakatRendern(cfg, jetzt, { datum, nacht, settings: { plakatGenre: genre } });
      const fig = document.createElement('div');
      fig.className = 'vsTag';
      fig.innerHTML = '<figure><figcaption>' + escapeHtml(datum) + ' · ' + pad2(jetzt.getHours()) + ':' + pad2(jetzt.getMinutes()) + '</figcaption>' + html + '</figure>';
      wurzel.appendChild(fig);
      plakatGlanzStarten(fig, cfg.settings);
    }
  }

  for (const id of ['vsOffset', 'vsModus', 'vsGenre', 'vsLive']) $(id).addEventListener('input', zeichnen);
  window.api.getConfig().then((c) => { cfg = c; $('vsGenre').checked = c.settings.plakatGenre !== false; zeichnen(); });
  window.api.onConfigChanged((c) => { cfg = c; zeichnen(); });
  setInterval(() => { if ($('vsLive').checked) zeichnen(); }, 10000);
})();
