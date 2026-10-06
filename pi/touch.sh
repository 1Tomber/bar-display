#!/usr/bin/env bash
#
# bar-display-touch: den Touch-Bildschirm auf seinen Platz im Fenster legen.
#
# Der Wayland-Aufsatz (cage) spannt ein Fenster ueber alle Bildschirme, links
# die LED-Wand, rechts daneben den Touch-Bildschirm am DSI-Anschluss. Einen
# Touch bildet er auf das ganze Fenster ab - ein Tipp unten rechts auf dem
# 7"-Bildschirm landete so weit rechts unten auf der Wand. Das Zuordnen ueber
# WL_OUTPUT kennt cage zwar, verrechnet sich damit aber (die Ausgaenge sind
# beim Anmelden des Touch noch nicht da). Also rechnen wir selbst: eine
# Kalibrierung fuer libinput, die die Touch-Flaeche (0..1) auf den Ausschnitt
# des Fensters legt, in dem der Bildschirm liegt.
#
# Laeuft als root vor der Anzeige (bar-display-touch.service). Liest die
# angeschlossenen Ausgaenge aus /sys/class/drm, nimmt die Reihenfolge nach
# connector_id (so reiht cage sie nebeneinander) und schreibt die udev-Regel.
set -euo pipefail
# Dezimalpunkt, kein Komma - libinput liest die Matrix englisch
export LC_ALL=C

REGEL=/etc/udev/rules.d/90-bar-display-touch.rules
TOUCH="${TOUCH_AUSGANG:-DSI}"     # Namensanfang des Ausgangs mit dem Touch

namen=() breiten=() hoehen=() ids=()
for d in /sys/class/drm/card*-*; do
  [ -f "$d/status" ] && [ "$(cat "$d/status")" = "connected" ] || continue
  modus="$(head -1 "$d/modes" 2>/dev/null || true)"
  [[ "$modus" =~ ^([0-9]+)x([0-9]+) ]] || continue
  n="${d##*/}"; n="${n#card*-}"                  # card0-DSI-1 -> DSI-1
  namen+=("$n"); breiten+=("${BASH_REMATCH[1]}"); hoehen+=("${BASH_REMATCH[2]}")
  ids+=("$(cat "$d/connector_id" 2>/dev/null || echo 999)")
done

schreiben() {
  {
    echo "# Von bar-display-touch geschrieben - nicht von Hand aendern."
    echo "# $1"
    echo "SUBSYSTEM==\"input\", ENV{ID_INPUT_TOUCHSCREEN}==\"1\", ENV{LIBINPUT_CALIBRATION_MATRIX}=\"$2\""
    # Die HDMI-CEC-Fernbedienung (vc4-hdmi) gilt fuer libinput als Zeigergeraet;
    # sobald der Aufsatz einen Zeiger sieht, zeichnet er den Pfeil. Ohne
    # Zeigergeraet blendet er ihn aus - also weg damit.
    echo "SUBSYSTEM==\"input\", ATTRS{name}==\"vc4-hdmi*\", ENV{LIBINPUT_IGNORE_DEVICE}=\"1\""
  } > "$REGEL"
  udevadm control --reload 2>/dev/null || true
  udevadm trigger --subsystem-match=input 2>/dev/null || true
}

# Nach connector_id sortieren
reihe=()
while read -r i; do reihe+=("$i"); done < <(for k in "${!ids[@]}"; do echo "${ids[$k]} $k"; done | sort -n | awk '{print $2}')

gesamtB=0 gesamtH=0 touchX='' touchB='' touchH=''
for k in "${reihe[@]}"; do
  if [[ "${namen[$k]}" == "$TOUCH"* ]] && [ -z "$touchX" ]; then
    touchX=$gesamtB; touchB=${breiten[$k]}; touchH=${hoehen[$k]}
  fi
  gesamtB=$((gesamtB + breiten[k]))
  [ "${hoehen[$k]}" -gt "$gesamtH" ] && gesamtH=${hoehen[$k]}
done

if [ -z "$touchX" ] || [ "${#reihe[@]}" -le 1 ]; then
  # Kein Touch-Bildschirm oder nur ein Bildschirm: die Flaeche ist das Fenster
  schreiben "ein Bildschirm - keine Umrechnung" "1 0 0 0 1 0"
  echo "Touch: ein Bildschirm, keine Umrechnung"
  exit 0
fi

a=$(awk -v b="$touchB" -v g="$gesamtB" 'BEGIN{printf "%.6f", b/g}')
c=$(awk -v x="$touchX" -v g="$gesamtB" 'BEGIN{printf "%.6f", x/g}')
e=$(awk -v h="$touchH" -v g="$gesamtH" 'BEGIN{printf "%.6f", h/g}')
schreiben "Fenster ${gesamtB}x${gesamtH}, Touch bei x=$touchX, ${touchB}x${touchH}" "$a 0 $c 0 $e 0"
echo "Touch: Fenster ${gesamtB}x${gesamtH}, Touch-Bildschirm bei x=$touchX (${touchB}x${touchH}) -> Matrix $a 0 $c 0 $e 0"
