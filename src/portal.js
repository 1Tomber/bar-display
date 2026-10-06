'use strict';

// Die Anmeldeseite zeigt die Adresse, unter der sie selbst geladen wurde:
// im Funkzugang ist das 10.42.0.1, am Kabel die Adresse im Hausnetz. Der
// Name plakat.local steht nur als Vorgabe im HTML, falls das Skript nicht
// laeuft (das Anmeldefenster mancher Handys ist sehr sparsam).
(function () {
  const el = document.getElementById('adresse');
  if (!el) return;
  const host = location.hostname;
  // Bei einem der abgefangenen Pruefnamen (captive.apple.com ...) hilft die
  // Adresse nichts - dann bleibt die Vorgabe stehen.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || /\.local$/.test(host) || host === 'plakat' || host === 'anzeige') {
    el.textContent = 'http://' + host + (location.port && location.port !== '80' ? ':' + location.port : '');
  }
})();
