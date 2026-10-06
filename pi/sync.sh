#!/usr/bin/env bash
# Arbeitsstand vom Rechner auf den Pi schieben - zum Entwickeln, ohne Git
# auf dem Geraet. Packt den Ordner (ohne node_modules, .git und Testkram),
# schickt ihn per ssh und startet den Dienst neu. Die Anzeige holt sich die
# Seite beim naechsten Neuzeichnen selbst.
#
#   pi/sync.sh                 -> nach tom@plakat.local:/opt/bar-display
#   PI=tom@192.168.1.50 pi/sync.sh
#   pi/sync.sh --kiosk         -> auch die Anzeige neu starten (pi/kiosk.sh geaendert);
#                                 wartet vorher, bis der Dienst wieder antwortet - sonst
#                                 bleibt Chromium auf einer weissen Seite haengen
#
# Beim allerersten Mal auf dem Pi danach:  sudo bash /opt/bar-display/pi/install.sh
set -euo pipefail

PI="${PI:-tom@plakat.local}"
ZIEL="${ZIEL:-/opt/bar-display}"
HIER="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> $HIER -> $PI:$ZIEL"
tar -C "$HIER" -czf - \
  --exclude=./node_modules --exclude=./.git --exclude=./test-results --exclude=./playwright-report \
  --exclude=./dist --exclude=./.ds-sync --exclude='./*.log' . \
| ssh "$PI" "sudo mkdir -p '$ZIEL' && sudo tar -xzf - -C '$ZIEL' --no-same-owner \
  && sudo chown -R \"\$(id -un)\":\"\$(id -un)\" '$ZIEL' \
  && for h in kiosk ap uhr touch rtc reset; do sudo install -m 0755 \"$ZIEL/pi/\$h.sh\" \"/usr/local/bin/bar-display-\$h\" 2>/dev/null || true; done \
  && (sudo systemctl restart bar-display.service 2>/dev/null && echo 'Dienst neu gestartet' || echo 'Dienst noch nicht eingerichtet - erst install.sh') \
  && if [ '${1:-}' = '--kiosk' ]; then \
       for i in \$(seq 1 30); do curl -sf http://localhost:8080/api/config >/dev/null 2>&1 && break; sleep 1; done; \
       sudo systemctl restart bar-display-kiosk.service && echo 'Anzeige neu gestartet'; fi"
