#!/usr/bin/env bash
#
# bar-display-uhr: die Systemuhr von Hand stellen - oder den Zeitabgleich
# aus dem Netz anstossen.
#
# Ein Pi ohne Netz und ohne Pufferbatterie startet mit irgendeiner Zeit. Das
# Bedienfeld am Geraet und die Einstellungsseite duerfen sie dann stellen:
#
#   bar-display-uhr 1790000000        Sekunden seit 1970 (UTC), wie Date.now()/1000
#   bar-display-uhr ntp               Zeitabgleich einschalten und neu anstossen
#
# date -s statt timedatectl set-time: das geht auch bei laufendem Zeitabgleich.
# Kommt spaeter doch ein Zeitserver, gewinnt der - so soll es sein. Gibt es
# eine Hardware-Uhr, bekommt sie die Zeit gleich mit.
set -euo pipefail
ARG="${1:-}"
if [ "$ARG" = "ntp" ]; then
  timedatectl set-ntp true 2>/dev/null || true
  systemctl restart systemd-timesyncd 2>/dev/null || true
  # Sobald der Abgleich durch ist, bekommt die Echtzeituhr die Zeit mit
  for _ in $(seq 1 20); do
    [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ] && break
    sleep 1
  done
  [ -e /dev/rtc0 ] && /usr/sbin/hwclock -w 2>/dev/null || true
  echo "ntp"
  exit 0
fi
[[ "$ARG" =~ ^[0-9]{9,11}$ ]] || { echo "Gebrauch: $0 SEKUNDEN_SEIT_1970 | ntp" >&2; exit 2; }
date -u -s "@$ARG" >/dev/null
[ -e /dev/rtc0 ] && /usr/sbin/hwclock -w 2>/dev/null || true
date -u +%s
