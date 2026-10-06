#!/usr/bin/env bash
#
# bar-display-rtc: eine Echtzeituhr am I2C finden und einbinden.
#
# Ein Pi hat keine batteriegepufferte Uhr. Steckt ein Uhrenbaustein auf dem
# I2C (DS3231, DS1307, PCF8523 auf 0x68 oder PCF8563 auf 0x51), laedt dieses
# Skript beim Start das passende Overlay - ohne Eintrag in der config.txt, so
# bleibt die Einrichtung fuer Geraete ohne Baustein dieselbe. Steht die
# Systemuhr noch nicht aus dem Netz, uebernimmt sie die Zeit aus dem Baustein.
#
#   bar-display-rtc            beim Start (bar-display-rtc.service)
#   bar-display-rtc schreiben  Systemzeit in den Baustein schreiben (nach dem
#                              Stellen von Hand oder einem Netzabgleich)
#
# Braucht dtparam=i2c_arm=on in der config.txt (setzt install.sh) und die
# Pakete i2c-tools und util-linux-extra (hwclock).
set -euo pipefail
export LC_ALL=C
HWCLOCK=/usr/sbin/hwclock

if [ "${1:-}" = "schreiben" ]; then
  [ -e /dev/rtc0 ] || { echo "keine Echtzeituhr"; exit 0; }
  $HWCLOCK -w && echo "Echtzeituhr gestellt: $($HWCLOCK -r)"
  exit 0
fi

modprobe i2c-dev 2>/dev/null || true
if [ ! -e /dev/i2c-1 ]; then echo "kein I2C-Bus - dtparam=i2c_arm=on fehlt in der config.txt?"; exit 0; fi

if [ ! -e /dev/rtc0 ]; then
  chip=""
  if command -v i2cdetect >/dev/null 2>&1; then
    if i2cdetect -y 1 0x68 0x68 2>/dev/null | grep -qE " 68| UU"; then chip=ds3231
    elif i2cdetect -y 1 0x51 0x51 2>/dev/null | grep -qE " 51| UU"; then chip=pcf8563; fi
  fi
  [ -n "$chip" ] || { echo "keine Echtzeituhr am I2C gefunden"; exit 0; }
  dtoverlay i2c-rtc,"$chip" 2>/dev/null || { echo "Overlay i2c-rtc,$chip liess sich nicht laden"; exit 0; }
  for _ in $(seq 1 20); do [ -e /dev/rtc0 ] && break; sleep 0.5; done
  [ -e /dev/rtc0 ] || { echo "Overlay geladen, aber kein /dev/rtc0"; exit 0; }
  echo "Echtzeituhr: $chip an 0x$([ "$chip" = pcf8563 ] && echo 51 || echo 68)"
fi

# Ohne Netzabgleich zaehlt der Baustein - er hat wenigstens eine Batterie
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" != "yes" ]; then
  if $HWCLOCK -s 2>/dev/null; then echo "Systemzeit aus der Echtzeituhr: $(date '+%d.%m.%Y %H:%M:%S')"; else echo "Echtzeituhr hat noch keine gueltige Zeit"; fi
else
  echo "Systemzeit kommt aus dem Netz - Echtzeituhr bleibt Reserve"
fi
