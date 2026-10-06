#!/usr/bin/env bash
#
# bar-display-ap: der eigene Funkzugang (Access Point) des Geraets.
#
# Handys kommen damit ohne fremdes WLAN an die Bedienseite - am Aufbauort gibt
# es oft keins. NetworkManager macht die ganze Arbeit: eine Verbindung im
# Modus "ap" mit ipv4.method shared bringt DHCP und DNS (sein eigener dnsmasq)
# gleich mit. Wir schreiben dafuer nur eine Schluesseldatei und laden sie.
#
#   bar-display-ap status                 Zustand als JSON
#   bar-display-ap anwenden MODUS SSID [versteckt]
#                                         Zugang einrichten und einschalten;
#                                         der Schluessel kommt auf stdin
#   bar-display-ap aus                    ausschalten
#
# MODUS ist offen (ohne Passwort) oder wpa2 (mit Passwort, 8 bis 63 Zeichen);
# "versteckt" als drittes Wort laesst den Namen unsichtbar - geht mit beidem.
# Der Schluessel wandert ueber stdin und nie ueber die Befehlszeile - die
# steht in jeder Prozessliste.
#
# Laeuft als root (sudo-Regel aus install.sh). Der Dienst ruft es auf, das
# Bedienfeld und die Einstellungsseite zeigen, was es meldet.
set -euo pipefail

NAME=bar-display-ap
DATEI="/etc/NetworkManager/system-connections/$NAME.nmconnection"
UUID=4f2c1b7e-7a11-4c58-9d0e-8a7b6c5d4e3f
IFACE="${AP_IFACE:-wlan0}"
ADRESSE="${AP_ADRESSE:-10.42.0.1}"
KANAL="${AP_KANAL:-6}"
LEASES="/var/lib/NetworkManager/dnsmasq-$IFACE.leases"

# JSON von Hand: nur wenige Felder, dafuer ohne Abhaengigkeit
json_text() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr -d '\n\r'; }

status() {
  local aktiv=false eingeschaltet=false modus=offen ssid='' versteckt=false schluessel='' ip='' geraete=0 fehler=''
  if [ -f "$DATEI" ]; then
    [ "$(sed -n 's/^autoconnect=//p' "$DATEI" | head -1)" = "true" ] && eingeschaltet=true
    ssid="$(sed -n 's/^ssid=//p' "$DATEI" | head -1)"
    [ "$(sed -n 's/^hidden=//p' "$DATEI" | head -1)" = "true" ] && versteckt=true
    schluessel="$(sed -n 's/^psk=//p' "$DATEI" | head -1)"
    if [ -n "$schluessel" ]; then modus=wpa2; else modus=offen; fi
    if nmcli -t -f NAME,STATE con show --active 2>/dev/null | grep -q "^$NAME:activated"; then
      aktiv=true
      ip="$(ip -4 -o addr show "$IFACE" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
      # grep -c meldet bei null Treffern "0" und Fehlercode 1 - also kein "|| echo 0"
      [ -f "$LEASES" ] && geraete="$(grep -c . "$LEASES" 2>/dev/null || true)"
      [ -n "$geraete" ] || geraete=0
    fi
  fi
  if ! nmcli -t -f DEVICE dev 2>/dev/null | grep -qx "$IFACE"; then fehler="Kein Funkgeraet $IFACE gefunden."; fi
  printf '{"verfuegbar":true,"aktiv":%s,"eingeschaltet":%s,"modus":"%s","ssid":"%s","versteckt":%s,"schluessel":"%s","ip":"%s","geraete":%s,"fehler":"%s"}\n' \
    "$aktiv" "$eingeschaltet" "$modus" "$(json_text "$ssid")" "$versteckt" "$(json_text "$schluessel")" "$ip" "${geraete:-0}" "$(json_text "$fehler")"
}

anwenden() {
  local modus="${1:-}" ssid="${2:-}" versteckt=false schluessel=''
  case "$modus" in offen|wpa2) ;; *) echo "Unbekannter Modus: $modus" >&2; exit 2;; esac
  [ "${3:-}" = "versteckt" ] && versteckt=true
  [ -n "$ssid" ] || { echo "SSID fehlt." >&2; exit 2; }
  [ "${#ssid}" -le 32 ] || { echo "SSID zu lang (hoechstens 32 Zeichen)." >&2; exit 2; }
  if [ "$modus" = wpa2 ]; then
    IFS= read -r schluessel || true
    [ "${#schluessel}" -ge 8 ] && [ "${#schluessel}" -le 63 ] || { echo "Passwort: 8 bis 63 Zeichen." >&2; exit 2; }
  fi

  # Funk an, Land gesetzt - sonst bleibt wlan0 stumm
  nmcli radio wifi on >/dev/null 2>&1 || true

  umask 077
  {
    echo "[connection]"
    echo "id=$NAME"
    echo "uuid=$UUID"
    echo "type=wifi"
    echo "interface-name=$IFACE"
    echo "autoconnect=true"
    echo "autoconnect-priority=10"
    echo
    echo "[wifi]"
    echo "mode=ap"
    echo "ssid=$ssid"
    echo "band=bg"
    echo "channel=$KANAL"
    echo "hidden=$versteckt"
    if [ "$modus" = wpa2 ]; then
      echo
      echo "[wifi-security]"
      echo "key-mgmt=wpa-psk"
      echo "psk=$schluessel"
      # Ohne diese Zeile bleibt der Funk des Pi (brcmfmac) beim Aufbau haengen:
      # "Hotspot network creation took too long" - keine geschuetzten
      # Verwaltungsrahmen (pmf). Mehr nicht: mit proto/pairwise/group dazu kam
      # der Handshake der Handys nie zu Ende (Station nach 80 ms wieder weg).
      echo "pmf=1"
    fi
    echo
    echo "[ipv4]"
    echo "method=shared"
    echo "address1=$ADRESSE/24"
    echo
    echo "[ipv6]"
    echo "method=disabled"
  } > "$DATEI"
  chmod 600 "$DATEI"

  nmcli con reload
  # Erst herunter, dann herauf: nur so uebernimmt NetworkManager geaenderte
  # Felder. Das Herunterfahren dauert auf dem Funk des Pi bis zu einer Minute
  # (wpa_supplicant raeumt den Zugang gemaechlich ab) - solange das Geraet noch
  # "deactivating" meldet, scheitert jedes con up. Also warten, dann zweimal
  # versuchen.
  nmcli con down "$NAME" >/dev/null 2>&1 || true
  for _ in $(seq 1 120); do
    z="$(nmcli -t -f DEVICE,STATE dev 2>/dev/null | sed -n "s/^$IFACE://p")"
    case "$z" in deactivating|"") sleep 1 ;; *) break ;; esac
  done
  hoch=false
  for _ in 1 2; do
    if nmcli con up "$NAME" >/dev/null 2>&1; then hoch=true; break; fi
    sleep 5
  done
  if [ "$hoch" != true ]; then
    printf '{"verfuegbar":true,"aktiv":false,"eingeschaltet":true,"modus":"%s","ssid":"%s","fehler":"Funkzugang liess sich nicht einschalten - Funk gesperrt oder Land nicht gesetzt?"}\n' \
      "$modus" "$(json_text "$ssid")"
    exit 1
  fi
  status
}

aus() {
  if [ -f "$DATEI" ]; then
    sed -i 's/^autoconnect=true/autoconnect=false/' "$DATEI"
    nmcli con reload
  fi
  nmcli con down "$NAME" >/dev/null 2>&1 || true
  status
}

case "${1:-status}" in
  status) status ;;
  anwenden) anwenden "${2:-}" "${3:-}" "${4:-}" ;;
  aus) aus ;;
  *) echo "Gebrauch: $0 status | anwenden MODUS SSID [versteckt] | aus" >&2; exit 2 ;;
esac
