#!/usr/bin/env bash
#
# bar-display-reset: Notausgang ueber die Boot-Partition.
#
# Die Boot-Partition (FAT) laesst sich an jedem Rechner beschreiben. Dort
# liegt bar-display-reset.txt mit auskommentierten Zeilen; wer eine davon
# freischaltet und das Geraet neu startet, bekommt beim Start:
#
#   funk=offen      Funkzugang ohne Passwort (der Name bleibt)
#   pin=aus         PIN der Bedienseite loeschen
#   ssh=an          SSH-Dienst einschalten
#   passwort=WORT   Anmeldepasswort des Benutzers setzen und SSH mit Passwort
#                   erlauben (die Zeile wird danach ohne das Wort vermerkt)
#
# Danach werden die Zeilen wieder auskommentiert und mit Datum vermerkt - jede
# Zeile wirkt genau einmal. Laeuft als root vor dem Dienst
# (bar-display-reset.service), nach NetworkManager.
set -euo pipefail

DATEI="${RESET_DATEI:-/boot/firmware/bar-display-reset.txt}"
BENUTZER="${BENUTZER:-tom}"
KONFIG="${KONFIG:-/home/$BENUTZER/.config/Bar Display/config.json}"

vorlage() {
  cat > "$DATEI" <<'TXT'
# bar-display-reset.txt - Notausgang, wenn PIN oder WLAN-Passwort verloren sind.
#
# Eine Zeile freischalten (das # davor entfernen), Karte zurueck ins Geraet,
# neu starten. Die Zeile wirkt einmal und wird dann wieder auskommentiert.
#
#funk=offen      # Funkzugang ohne Passwort (Name bleibt)
#pin=aus         # PIN der Bedienseite loeschen
#ssh=an          # SSH-Dienst einschalten
#passwort=WORT   # Anmeldepasswort des Benutzers setzen, SSH mit Passwort erlauben
#                # (WORT ersetzen; kein # im Passwort - es wird danach aus der Datei entfernt)
TXT
}

if [ ! -f "$DATEI" ]; then
  if [ -d "$(dirname "$DATEI")" ]; then vorlage; echo "Vorlage angelegt: $DATEI"; fi
  exit 0
fi

getan=()
while IFS= read -r roh; do
  roh="${roh%%#*}"
  case "$roh" in
    *passwort=*) zeile="passwort=$(printf '%s' "${roh#*passwort=}" | sed 's/[[:space:]]*$//')" ;;
    *) zeile="$(echo "$roh" | tr -d '[:space:]')" ;;
  esac
  case "$zeile" in
    funk=offen)
      ssid="$(sed -n 's/^ssid=//p' /etc/NetworkManager/system-connections/bar-display-ap.nmconnection 2>/dev/null | head -1)"
      [ -n "$ssid" ] || ssid="$(hostname | tr '[:lower:]' '[:upper:]' | cut -c1-32)"
      if /usr/local/bin/bar-display-ap anwenden offen "$ssid" >/dev/null 2>&1; then getan+=("funk=offen"); else echo "Funkzugang liess sich nicht umstellen" >&2; fi ;;
    pin=aus)
      if [ -f "$KONFIG" ] && python3 - "$KONFIG" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding='utf-8'))
c.setdefault('settings', {})['pin'] = ''
json.dump(c, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
      then chown "$BENUTZER":"$BENUTZER" "$KONFIG" 2>/dev/null || true; getan+=("pin=aus"); else echo "PIN liess sich nicht loeschen" >&2; fi ;;
    ssh=an)
      if systemctl enable --now ssh >/dev/null 2>&1; then getan+=("ssh=an"); else echo "SSH liess sich nicht einschalten" >&2; fi ;;
    passwort=*)
      wort="${zeile#passwort=}"
      if [ -n "$wort" ] && [ "$wort" != "WORT" ] && printf '%s:%s\n' "$BENUTZER" "$wort" | chpasswd; then
        mkdir -p /etc/ssh/sshd_config.d
        printf 'PasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/10-bar-display.conf
        systemctl reload ssh >/dev/null 2>&1 || true
        # das Wort verschwindet aus der Datei, nur der Vermerk bleibt
        sed -i "s/^[[:space:]]*passwort=.*/#passwort=WORT   # (gesetzt)/" "$DATEI"
        getan+=("passwort")
      else echo "Passwort liess sich nicht setzen" >&2; fi ;;
    "") ;;
    *) echo "Unbekannte Zeile in $DATEI: $zeile" >&2 ;;
  esac
done < "$DATEI"

if [ "${#getan[@]}" -gt 0 ]; then
  # Erledigte Zeilen wieder auskommentieren und vermerken
  for g in "${getan[@]}"; do sed -i "s/^[[:space:]]*$g/#$g/" "$DATEI"; done
  printf '# erledigt am %s: %s\n' "$(date '+%d.%m.%Y %H:%M')" "${getan[*]}" >> "$DATEI"
  echo "Erledigt: ${getan[*]}"
fi
