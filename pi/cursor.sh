#!/usr/bin/env bash
#
# bar-display-cursor: einen unsichtbaren Mauszeiger einrichten.
#
# Auf der Wand und dem Touch-Bildschirm hat ein Pfeil nichts verloren. Die
# Seite blendet ihren eigenen Zeiger per CSS aus, aber der Wayland-Aufsatz
# (cage) zeichnet daneben seinen eigenen - und kennt keinen Schalter dafuer.
# Also bekommt er ein Zeiger-Thema, in dem jeder Zeiger ein einzelner
# durchsichtiger Pixel ist (Xcursor-Datei, 64 Byte). kiosk.sh setzt dann
# XCURSOR_THEME darauf - fuer cage und Chromium gleichermassen.
set -euo pipefail
ZIEL="${1:-/usr/share/icons/bar-display-leer}"
mkdir -p "$ZIEL/cursors"
printf '[Icon Theme]\nName=bar-display-leer\nComment=Unsichtbarer Zeiger fuer die Anzeige\n' > "$ZIEL/index.theme"
echo 'WGN1chAAAAAAAAEAAQAAAAIA/f8YAAAAHAAAACQAAAACAP3/GAAAAAEAAAABAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAA=' | base64 -d > "$ZIEL/cursors/default"
for n in left_ptr arrow pointer hand1 hand2 pointing_hand text xterm ibeam watch wait progress crosshair cross \
         top_left_arrow move grab grabbing col-resize row-resize ew-resize ns-resize nesw-resize nwse-resize \
         n-resize s-resize e-resize w-resize ne-resize nw-resize se-resize sw-resize not-allowed no-drop \
         help question_arrow context-menu copy alias cell vertical-text zoom-in zoom-out all-scroll fleur; do
  # echte Dateien, keine Verweise: wlroots liest beim Laden nur regulaere Dateien
  cp -f "$ZIEL/cursors/default" "$ZIEL/cursors/$n"
done
echo "Zeiger-Thema unter $ZIEL"
