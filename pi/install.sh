#!/usr/bin/env bash
#
# Bar Display auf einem Einplatinenrechner einrichten.
#
#   curl -fsSL https://raw.githubusercontent.com/Tarmac-Festival/bar-display/main/pi/install.sh | bash
#
# Gedacht fuer Raspberry Pi OS (Bookworm) auf einem Pi 3B, laeuft aber auf jedem
# Debian-artigen Linux mit systemd - etwa Armbian oder Ubuntu auf einem Odroid
# N2+. Was nur den Pi betrifft (die Firmware-Datei config.txt), wird auf anderen
# Brettern uebersprungen; alles andere ist gewoehnliches Linux.
#
# Richtet zwei Dienste ein:
#   bar-display        - der kleine Webdienst (Anzeige + Bedienseite)
#   bar-display-kiosk  - Chromium im Vollbild, zeigt die Anzeige
#
set -euo pipefail

# Beide lassen sich von aussen setzen - etwa fuer eine eigene Abspaltung oder
# einen anderen Ordner. Liegt in ZIEL schon ein Programm ohne .git (von Hand
# hinueberkopiert, siehe pi/sync.sh), bleibt es unangetastet.
REPO="${REPO:-https://github.com/Tarmac-Festival/bar-display.git}"
ZIEL="${ZIEL:-/opt/bar-display}"
BENUTZER="${SUDO_USER:-${USER:-$(id -un)}}"
PORT="${PORT:-8080}"
PORTAL_PORT="${PORTAL_PORT:-80}"
# Eigener Funkzugang (Access Point) fuer Handys: ja/nein, und das Land fuer den Funk
AP="${AP:-ja}"
WLAN_LAND="${WLAN_LAND:-DE}"

sage() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warne() { printf '\n\033[1;33m!!\033[0m %s\n' "$*"; }

if [ "$(id -u)" -eq 0 ] && [ -z "${SUDO_USER:-}" ]; then
  warne "Bitte nicht direkt als root ausfuehren, sondern mit sudo als normaler Benutzer."
  exit 1
fi

# ---------------------------------------------------------------------------
# Welches Brett ist das? Davon haengt nur eines ab: ob es eine config.txt gibt,
# in der der Grafiktreiber steht. Das ist eine Eigenheit der Raspberry-Pi-
# Firmware. Andere Bretter bringen ihren Treiber im Kernel mit, dort waere jedes
# Herumschreiben am Bootbereich bestenfalls wirkungslos.
#
# MODELL_DATEIEN und NUR_ERKENNEN sind nur zum Pruefen da (test/brett.test.js).
# Ein eigenes Skript waere sauberer, geht hier aber nicht: dieses hier wird per
# "curl | bash" ausgefuehrt, da ist noch nichts zum Nachladen da. Zwei Zeilen
# fuer die eine Entscheidung, an der alles Weitere haengt.
BRETT="unbekannt"
for k in ${MODELL_DATEIEN:-/proc/device-tree/model /sys/firmware/devicetree/base/model}; do
  if [ -r "$k" ]; then
    BRETT="$(tr -d '\0' < "$k")"
    break
  fi
done
case "$BRETT" in
  *"Raspberry Pi"*) IST_PI=1 ;;
  *) IST_PI=0 ;;
esac
# Konsole oder Arbeitsflaeche? Zwei ganz verschiedene Wege:
#
#   konsole  cage uebernimmt tty1. Braucht den Bildschirm fuer sich - und
#            bekommt ihn nur, wenn keine Arbeitsflaeche laeuft.
#   desktop  Chromium startet in der vorhandenen Sitzung, etwa unter GNOME.
#
# Frueher gab es nur den ersten Weg, und bei einer vorhandenen Arbeitsflaeche
# den Rat, sie abzuschalten. Auf einem Geraet, das jemand bewusst mit
# Arbeitsflaeche aufgesetzt hat, ist das die falsche Antwort.
STANDARDZIEL="${STANDARDZIEL:-$(systemctl get-default 2>/dev/null || echo unbekannt)}"
#
# Auf einem Pi bleibt es beim schlanken Aufsatz, auch wenn eine Arbeitsflaeche
# da ist: ein Pi 3B hat 1 GB, und Raspberry Pi OS wird meistens mit
# Arbeitsflaeche installiert, ohne dass jemand sie hier braucht. Dort kommt
# weiter der Rat, auf Konsolenstart umzustellen - mit KIOSK=desktop laesst er
# sich uebergehen.
if [ -n "${KIOSK:-}" ]; then
  KIOSK_ART="$KIOSK"
elif [ "$IST_PI" -eq 0 ] && [ "$STANDARDZIEL" = "graphical.target" ]; then
  KIOSK_ART="desktop"
else
  KIOSK_ART="konsole"
fi

[ -n "${NUR_ERKENNEN:-}" ] && { printf '%s|%s|%s\n' "$BRETT" "$IST_PI" "$KIOSK_ART"; exit 0; }
sage "Geraet: $BRETT"
sage "Anzeige: $([ "$KIOSK_ART" = desktop ] && echo 'in der Arbeitsflaeche' || echo 'eigener Vollbildaufsatz')"

# ---------------------------------------------------------------------------
sage "Pakete installieren"
sudo apt-get update -qq
PAKETE="git nodejs"
# cage nur, wo es gebraucht wird: in einer Arbeitsflaeche waere es nutzlos.
[ "$KIOSK_ART" = "konsole" ] && PAKETE="$PAKETE cage"
# i2c-tools und hwclock (util-linux-extra) fuer eine Echtzeituhr am I2C (pi/rtc.sh)
PAKETE="$PAKETE i2c-tools util-linux-extra"
# shellcheck disable=SC2086
sudo apt-get install -y --no-install-recommends $PAKETE

# Chromium heisst je nach Fassung anders
CHROMIUM=""
for k in chromium chromium-browser; do
  if command -v "$k" >/dev/null 2>&1; then CHROMIUM="$(command -v "$k")"; break; fi
done
if [ -z "$CHROMIUM" ]; then
  sudo apt-get install -y --no-install-recommends chromium || sudo apt-get install -y --no-install-recommends chromium-browser
  for k in chromium chromium-browser; do
    if command -v "$k" >/dev/null 2>&1; then CHROMIUM="$(command -v "$k")"; break; fi
  done
fi
[ -n "$CHROMIUM" ] || { warne "Chromium nicht gefunden - Einrichtung abgebrochen."; exit 1; }

# Was sich per Option nicht mehr abstellen laesst, regelt eine Richtlinie: die
# Uebersetzen-Blase ("German | English") haengt sich sonst an die obere rechte
# Ecke des Fensters - auf einer zweiten Anzeige mitten ins Bild, und ein
# Kiosk hat niemanden, der sie wegklickt. Debian und Raspberry Pi OS lesen
# /etc/chromium/policies/managed; wo Chromium anders heisst, liegt der Ordner
# daneben.
for ordner in /etc/chromium /etc/chromium-browser; do
  sudo mkdir -p "$ordner/policies/managed"
  sudo tee "$ordner/policies/managed/bar-display.json" >/dev/null <<'RICHTLINIE'
{
  "TranslateEnabled": false,
  "SpellCheckServiceEnabled": false,
  "DefaultBrowserSettingEnabled": false,
  "BackgroundModeEnabled": false,
  "PromotionsEnabled": false
}
RICHTLINIE
done

NODE_HAUPT="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_HAUPT" -lt 16 ]; then
  warne "Node.js ist zu alt (gefunden: $(node --version 2>/dev/null || echo keins))."
  warne "Bitte eine neuere Fassung installieren, z.B. ueber https://deb.nodesource.com"
  exit 1
fi

# ---------------------------------------------------------------------------
sage "Uhrzeit aus dem Netz beziehen"
# Ein Raspberry Pi hat keine batteriegepufferte Uhr. Ohne Abgleich startet er mit
# der Zeit des letzten Herunterfahrens - das sieht plausibel aus und ist trotzdem
# falsch. Daran haengt hier alles: Timetable, Zeitfenster der Clips, Ruhezeit und
# die geplanten Durchsagen.
sudo apt-get install -y --no-install-recommends systemd-timesyncd fake-hwclock \
  || warne "Zeitpakete liessen sich nicht installieren - bitte von Hand nachholen."

# Neben den oeffentlichen Servern auch das eigene Netz fragen. Auf einem
# Flugplatz ohne Internetzugang beantwortet oft der WLAN-Router die Zeitanfrage,
# und das ist immer noch besser als gar kein Abgleich.
GATEWAY="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
sudo mkdir -p /etc/systemd/timesyncd.conf.d
sudo tee /etc/systemd/timesyncd.conf.d/bar-display.conf >/dev/null <<ZEIT
[Time]
NTP=${GATEWAY:+$GATEWAY }pool.ntp.org
FallbackNTP=time.cloudflare.com time.google.com
ZEIT

sudo systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || true
sudo timedatectl set-ntp true >/dev/null 2>&1 || true

# fake-hwclock merkt sich die Zeit beim Herunterfahren. Kommt der Strom zurueck
# und es ist kein Netz da, startet der Pi wenigstens nicht im Jahr 1970.
sudo systemctl enable fake-hwclock >/dev/null 2>&1 || true
sudo fake-hwclock save >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
sage "Programm nach $ZIEL holen"
if [ -d "$ZIEL/.git" ]; then
  sudo git -C "$ZIEL" fetch --depth 1 origin main
  sudo git -C "$ZIEL" reset --hard origin/main
elif [ -f "$ZIEL/package.json" ]; then
  sage "Programm liegt schon in $ZIEL (ohne .git) - wird nicht angefasst"
else
  sudo rm -rf "$ZIEL"
  sudo git clone --depth 1 "$REPO" "$ZIEL"
fi
sudo chown -R "$BENUTZER":"$BENUTZER" "$ZIEL"

# ---------------------------------------------------------------------------
sage "Dienst fuer die Anzeige einrichten"
sudo tee /etc/systemd/system/bar-display.service >/dev/null <<DIENST
[Unit]
Description=Bar Display - Anzeige und Bedienseite
After=network-online.target time-sync.target
Wants=network-online.target
# Absichtlich nur After= und kein Requires= auf time-sync.target: ohne Netz
# wuerde die Anzeige sonst gar nicht erst starten. Lieber eine laufende Anzeige
# mit Warnhinweis als ein schwarzer Bildschirm.

[Service]
Type=simple
User=$BENUTZER
Environment=PORT=$PORT
# Zweiter Anschluss auf Port 80: dort fragen Handys nach dem Anmeldefenster
# (captive portal), und die Bedienseite geht ohne Portnummer auf. Port 80
# darf sonst nur root - die Faehigkeit dafuer bekommt der Dienst hier.
Environment=PORTAL_PORT=$PORTAL_PORT
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=$(command -v node) $ZIEL/pi/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
DIENST

# ---------------------------------------------------------------------------
sage "Vollbildanzeige einrichten"
# Chromium-Zwischenspeicher ins RAM. Die SD-Karte ist im Dauerbetrieb das
# schwaechste Glied - je weniger darauf geschrieben wird, desto besser. Den
# Ordner legt systemd selbst unter /run an (RuntimeDirectory weiter unten),
# mit den richtigen Rechten und ohne in /run/user hineinzupfuschen.
CACHE="/run/bar-display-cache"
# cage ist ein winziger Wayland-Aufsatz: kein Desktop, kein Panel, nichts das
# Speicher frisst - auf einem Pi 3B mit 1 GB macht das einen spuerbaren
# Unterschied gegenueber einer vollen Arbeitsflaeche.
sudo install -m 0755 "$ZIEL/pi/kiosk.sh" /usr/local/bin/bar-display-kiosk

sudo tee /etc/systemd/system/bar-display-kiosk.service >/dev/null <<KIOSK
[Unit]
Description=Bar Display - Vollbild
After=bar-display.service
Wants=bar-display.service
# Auf tty1 sitzt bei Konsolenstart der automatische Login. Ohne Conflicts
# streiten sich beide um denselben Bildschirm: systemd haengt den Login ab,
# getty startet nach, und die Anzeige kommt nie zum Zug. Conflicts sorgt dafuer,
# dass systemd den Login sauber beendet, bevor die Anzeige uebernimmt.
After=getty@tty1.service bar-display-touch.service
Wants=bar-display-touch.service
Conflicts=getty@tty1.service

[Service]
Type=simple
User=$BENUTZER
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
TTYReset=yes
TTYVHangup=yes
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u "$BENUTZER")
Environment=PORT=$PORT
Environment=CHROMIUM=$CHROMIUM
Environment=CACHE=$CACHE
# Mit zwei Bildschirmen (LED-Wand am HDMI, 7"-Touch am DSI) friert auf dem Pi
# einer von beiden nach dem ersten Bild ein - der Bildwechsel wird nie als
# fertig gemeldet. Schuld sind die DRM-Format-Modifier des vc4-Treibers; ohne
# sie laufen beide (gemessen 2026-09-22, wlroots 0.18, Trixie).
Environment=WLR_DRM_NO_MODIFIERS=1
RuntimeDirectory=bar-display-cache
RuntimeDirectoryPreserve=yes
# Bewusst kein ExecStartPre: TTYVHangup haengt vor dem Start alles von tty1 ab,
# und ein Kontrollprozess haengt wegen StandardInput=tty selbst daran. Er bekam
# SIGHUP, der Dienst scheiterte mit "code=killed, status=1/HUP" und startete
# endlos neu. Das Warten auf den Webdienst macht jetzt das Startskript selbst.
ExecStart=/usr/local/bin/bar-display-kiosk
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
KIOSK

# Womit die Anzeige laeuft, muessen auch die Helferbefehle wissen: im
# Desktop-Weg gibt es den Dienst bar-display-kiosk gar nicht.
sudo tee /etc/default/bar-display >/dev/null <<EINST
# Von der Einrichtung geschrieben. Wird von bar-display-konsole,
# bar-display-anzeige und bar-display-update gelesen.
KIOSK_ART=$KIOSK_ART
PORT=$PORT
EINST

sudo systemctl daemon-reload

# Bewusst ohne Abbruch: startet die Anzeige nicht, sollen die restlichen
# Einstellungen trotzdem gesetzt werden - sonst steht der Pi halb eingerichtet
# da und selbst "bar-display-update" fehlt.
DIENST_OK=ja
KIOSK_OK=ja
sudo systemctl enable --now bar-display.service || DIENST_OK=nein

if [ "$KIOSK_ART" = "desktop" ]; then
  # In einer Arbeitsflaeche startet die Anzeige mit der Sitzung, nicht als
  # Systemdienst: der Bildschirm gehoert dort dem Anmeldedienst, und ein
  # Dienst auf tty1 kaeme nie zum Zug. Ausserdem laeuft Chromium unter Ubuntu
  # als Snap - der braucht die Sitzung des Benutzers.
  sudo systemctl disable --now bar-display-kiosk.service >/dev/null 2>&1 || true

  AUTOSTART="/home/$BENUTZER/.config/autostart"
  sudo -u "$BENUTZER" mkdir -p "$AUTOSTART"
  sudo -u "$BENUTZER" tee "$AUTOSTART/bar-display-kiosk.desktop" >/dev/null <<AUTO
[Desktop Entry]
Type=Application
Name=Bar Display
Comment=Vollbildanzeige in der laufenden Sitzung
Exec=env KIOSK_ART=desktop PORT=$PORT /usr/local/bin/bar-display-kiosk
X-GNOME-Autostart-enabled=true
NoDisplay=true
AUTO
  KIOSK_OK=ja
else
  sudo systemctl enable --now bar-display-kiosk.service || KIOSK_OK=nein
fi

# ---------------------------------------------------------------------------
# Die Vollbildanzeige braucht tty1 fuer sich. Startet der Pi mit Arbeitsflaeche,
# sitzt die dort schon - dann kommen sich beide in die Quere.
KONSOLE_HINWEIS=""
if [ "$KIOSK_ART" = "desktop" ]; then
  KONSOLE_HINWEIS="Die Anzeige startet mit der Arbeitsflaeche. Damit sie ohne
  Tastatur hochkommt, muss der Benutzer automatisch angemeldet werden -
  unter GNOME in /etc/gdm3/custom.conf:
      AutomaticLoginEnable = true
      AutomaticLogin = $BENUTZER
  Der Bildschirmschoner wird beim Start abgeschaltet, darum ist nichts zu tun.
  (Ohne Arbeitsflaeche geht es auch: KIOSK=konsole erneut einrichten und
  sudo systemctl set-default multi-user.target)"
elif [ "$STANDARDZIEL" = "graphical.target" ]; then
  if [ "${KONSOLENSTART:-}" = "ja" ]; then
    sage "Auf Start ohne Arbeitsflaeche umstellen"
    sudo systemctl set-default multi-user.target >/dev/null
    KONSOLE_HINWEIS="Umgestellt auf Start ohne Arbeitsflaeche - wirkt nach dem Neustart."
  else
    KONSOLE_HINWEIS="ACHTUNG: Das Geraet startet mit Arbeitsflaeche, die Anzeige
  wurde aber als eigener Vollbildaufsatz eingerichtet. Der braucht tty1 fuer
  sich und kommt so nicht hoch. Umstellen mit:
      sudo systemctl set-default multi-user.target && sudo reboot
  (Oder mit KIOSK=desktop erneut einrichten - dann bleibt die Arbeitsflaeche.)"
  fi
fi

# ---------------------------------------------------------------------------
sage "System auf Dauerbetrieb trimmen"

# gpu_mem war hier frueher auf 128 gesetzt - das war ein Rat aus der Zeit des
# alten Grafiktreibers. Aktuelles Raspberry Pi OS nutzt vc4-kms-v3d und verteilt
# den Speicher selbst. Schlimmer: mit gesetztem gpu_mem kam der Treiber auf
# einem Pi 3B gar nicht mehr hoch, /dev/dri verschwand, und die Vollbildanzeige
# fand kein Grafikgeraet mehr. Deshalb wird die Zeile jetzt entfernt, auch bei
# Geraeten, auf denen ein frueherer Lauf sie hinterlassen hat.
BOOTCFG=""
if [ "$IST_PI" -eq 1 ]; then
  for k in /boot/firmware/config.txt /boot/config.txt; do
    [ -f "$k" ] && { BOOTCFG="$k"; break; }
  done
fi
GPUMEM_HINWEIS=""
if [ -n "$BOOTCFG" ] && grep -q '^gpu_mem=' "$BOOTCFG"; then
  sudo sed -i '/^gpu_mem=/d' "$BOOTCFG"
  sage "veraltete Zeile gpu_mem aus $BOOTCFG entfernt"
  GPUMEM_HINWEIS="Die veraltete Einstellung gpu_mem wurde entfernt - sie hat den
  Grafiktreiber blockiert. Das wirkt erst nach einem Neustart:
      sudo reboot"
fi

# Ohne dtoverlay=vc4-kms-v3d gibt es keinen Grafiktreiber und damit kein
# /dev/dri - die Vollbildanzeige findet dann nichts, worauf sie zeichnen kann.
#
# Hier wird ausnahmsweise am Bootbereich geschrieben, denn genau das ist einem
# Geraet passiert: die config.txt war leer, und ohne sie kommt keine Grafik.
# Deshalb vorsichtig: erst Sicherungskopie, dann nur das Noetigste, danach
# Gegenprobe - und schlaegt die fehl, wird die Sicherung zurueckgespielt.
BOOT_HINWEIS=""
if [ -n "$BOOTCFG" ]; then
  BOOT_TAT=""
  SICHERUNG="$BOOTCFG.vor-bar-display"

  if [ ! -s "$BOOTCFG" ]; then
    # Ganz leer: der Standardinhalt von Raspberry Pi OS muss zurueck.
    sudo cp -a "$BOOTCFG" "$SICHERUNG" 2>/dev/null || true
    sage "$BOOTCFG ist leer - Standardinhalt wird geschrieben"

    # arm_64bit nur bei einem 64-Bit-System. Bei einem 32-Bit-Userland wuerde
    # die Zeile einen Kernel starten, der nicht dazu passt.
    BIT64=""
    [ "$(uname -m)" = "aarch64" ] && BIT64="arm_64bit=1"

    sudo tee "$BOOTCFG" >/dev/null <<BOOTSTD
# For more options and information see http://rptl.io/configtxt
# Von Bar Display wiederhergestellt - die Datei war leer.

dtparam=audio=on
camera_auto_detect=1
display_auto_detect=1
auto_initramfs=1

# Grafiktreiber - ohne diese Zeile gibt es kein /dev/dri
dtoverlay=vc4-kms-v3d
max_framebuffers=2
disable_fw_kms_setup=1
$BIT64
disable_overscan=1
arm_boost=1

[cm4]
otg_mode=1

[cm5]
dtoverlay=dwc2,dr_mode=host

[all]
BOOTSTD
    BOOT_TAT="wiederhergestellt"

  elif ! grep -q '^dtoverlay=vc4-kms-v3d' "$BOOTCFG"; then
    # Datei hat Inhalt, aber der Grafiktreiber fehlt: nur anhaengen, damit
    # eigene Einstellungen der Bar erhalten bleiben.
    sudo cp -a "$BOOTCFG" "$SICHERUNG" 2>/dev/null || true
    sage "dtoverlay=vc4-kms-v3d fehlte in $BOOTCFG - wird ergaenzt"
    printf '\n# Von Bar Display ergaenzt - ohne diese Zeile gibt es kein /dev/dri\ndtoverlay=vc4-kms-v3d\nmax_framebuffers=2\n' \
      | sudo tee -a "$BOOTCFG" >/dev/null
    BOOT_TAT="ergaenzt"
  fi

  # Gegenprobe: hat es wirklich funktioniert?
  if [ -n "$BOOT_TAT" ]; then
    if [ -s "$BOOTCFG" ] && grep -q '^dtoverlay=vc4-kms-v3d' "$BOOTCFG"; then
      BOOT_HINWEIS="Die Grafik-Einstellung in $BOOTCFG wurde $BOOT_TAT
  (Sicherung: $SICHERUNG). Das wirkt erst nach einem Neustart:
      sudo reboot"
    else
      warne "Schreiben in $BOOTCFG hat nicht geklappt - Sicherung wird zurueckgespielt."
      [ -f "$SICHERUNG" ] && sudo cp -a "$SICHERUNG" "$BOOTCFG"
      BOOT_HINWEIS="ACHTUNG: $BOOTCFG liess sich nicht reparieren. Ohne die Zeile
  dtoverlay=vc4-kms-v3d bleibt der Bildschirm schwarz - bitte von Hand nachsehen."
    fi
  fi
fi

# Auf anderen Brettern wird am Bootbereich nichts angefasst - dort bringt der
# Kernel den Treiber mit. Nachsehen, ob er auch geladen ist, kostet nichts und
# erspart die Suche nach einem schwarzen Bildschirm.
if [ "$IST_PI" -eq 0 ] && [ ! -d /dev/dri ]; then
  warne "Kein /dev/dri - es ist kein Grafiktreiber geladen."
  warne "Ohne ihn bleibt der Bildschirm schwarz. Bei Armbian hilft meist ein"
  warne "aktueller Kernel; pruefen laesst es sich mit: ls /dev/dri/"
  BOOT_HINWEIS="ACHTUNG: /dev/dri fehlt - es ist kein Grafiktreiber geladen.
  Die Anzeige findet dann nichts, worauf sie zeichnen kann."
fi

# WLAN-Stromsparen verzoegert die Push-Verbindung zur Bedienseite: Durchsagen
# vom Handy kaemen sonst mit Verspaetung an.
sudo tee /etc/systemd/system/bar-display-wlan.service >/dev/null <<'WLAN'
[Unit]
Description=Bar Display - WLAN-Stromsparen abschalten
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'for d in /sys/class/net/wl*; do iw dev "$(basename "$d")" set power_save off || true; done'

[Install]
WantedBy=multi-user.target
WLAN
sudo systemctl enable --now bar-display-wlan.service >/dev/null 2>&1 || true

# Protokolle ins RAM statt auf die SD-Karte
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/bar-display.conf >/dev/null <<'JOURNAL'
[Journal]
Storage=volatile
RuntimeMaxUse=32M
JOURNAL
sudo systemctl restart systemd-journald >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Die LED-Wand: ihr Colorlight-Sender beantwortet die EDID-Anfrage beim ersten
# Start nicht, der Kernel faellt dann auf 640x480 zurueck. Liegt die EDID der
# Wand im Repository (pi/led-224x784.edid), bekommt der Kernel sie als Datei
# und die Betriebsart fest vorgegeben. Nur auf dem Pi, nur wenn noch nicht da.
LED_EDID="${LED_EDID:-$ZIEL/pi/led-224x784.edid}"
if [ "$IST_PI" -eq 1 ] && [ -f "$LED_EDID" ] && [ -f /boot/firmware/cmdline.txt ]; then
  sage "EDID der LED-Wand fuer den Kernel hinterlegen"
  sudo install -D -m 0644 "$LED_EDID" /lib/firmware/edid/led-224x784.bin
  if ! grep -q 'drm.edid_firmware=HDMI-A-1' /boot/firmware/cmdline.txt; then
    sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.vor-plakat
    sudo sed -i '1 s|$| drm.edid_firmware=HDMI-A-1:edid/led-224x784.bin video=HDMI-A-1:224x784@60D|' /boot/firmware/cmdline.txt
    echo "cmdline.txt ergaenzt (Sicherung: cmdline.txt.vor-plakat) - wirkt nach dem naechsten Neustart"
  fi
fi

# ---------------------------------------------------------------------------
sage "Helfer fuer Uhr und Funkzugang"
# Zwei kleine Befehle, die root brauchen und die der Dienst per sudo aufruft:
# die Uhr stellen (Pi ohne Netz und ohne Pufferbatterie) und den eigenen
# Funkzugang schalten. Sie liegen root-eigen unter /usr/local/bin, damit die
# sudo-Regel nicht auf eine Datei zeigt, die der Dienstbenutzer aendern kann.
sudo install -m 0755 "$ZIEL/pi/uhr.sh" /usr/local/bin/bar-display-uhr
sudo install -m 0755 "$ZIEL/pi/ap.sh" /usr/local/bin/bar-display-ap
# und ein Zeiger-Thema, das nichts zeichnet (siehe pi/cursor.sh)
sudo bash "$ZIEL/pi/cursor.sh" >/dev/null

# Echtzeituhr am I2C (pi/rtc.sh): beim Start suchen und einbinden. Dafuer muss
# der I2C-Bus an sein - das ist der eine Eintrag in der config.txt, den ein
# Uhrenbaustein braucht; das Overlay selbst laedt das Skript zur Laufzeit.
sudo install -m 0755 "$ZIEL/pi/rtc.sh" /usr/local/bin/bar-display-rtc
if [ -n "${BOOTCFG:-}" ] && [ -f "$BOOTCFG" ] && ! grep -q '^dtparam=i2c_arm=on' "$BOOTCFG"; then
  sudo sed -i 's/^#dtparam=i2c_arm=on/dtparam=i2c_arm=on/' "$BOOTCFG"
  grep -q '^dtparam=i2c_arm=on' "$BOOTCFG" || echo 'dtparam=i2c_arm=on' | sudo tee -a "$BOOTCFG" >/dev/null
  I2C_HINWEIS="I2C wurde in $BOOTCFG eingeschaltet - eine Echtzeituhr wird nach dem naechsten Neustart erkannt."
fi
sudo tee /etc/systemd/system/bar-display-rtc.service >/dev/null <<'RTC'
[Unit]
Description=Bar Display - Echtzeituhr am I2C einbinden
DefaultDependencies=no
After=sysinit.target
Before=time-sync.target bar-display.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/bar-display-rtc

[Install]
WantedBy=sysinit.target
RTC
# Nach jedem Netzabgleich die Echtzeituhr nachstellen: systemd-timesyncd
# wartet auf time-sync.target; ein kleiner Dienst dahinter schreibt den Baustein.
sudo tee /etc/systemd/system/bar-display-rtc-schreiben.service >/dev/null <<'RTC2'
[Unit]
Description=Bar Display - Echtzeituhr nach dem Netzabgleich stellen
After=time-sync.target
Wants=time-sync.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/bar-display-rtc schreiben

[Install]
WantedBy=multi-user.target
RTC2
sudo systemctl daemon-reload
sudo systemctl enable bar-display-rtc.service bar-display-rtc-schreiben.service >/dev/null 2>&1 || true
sudo systemctl start bar-display-rtc.service >/dev/null 2>&1 || true

# Notausgang ueber die Boot-Partition (pi/reset.sh): PIN weg, Funk offen, SSH an
sudo install -m 0755 "$ZIEL/pi/reset.sh" /usr/local/bin/bar-display-reset
sudo tee /etc/systemd/system/bar-display-reset.service >/dev/null <<RESET
[Unit]
Description=Bar Display - Notausgang von der Boot-Partition
After=NetworkManager.service
Before=bar-display.service

[Service]
Type=oneshot
Environment=BENUTZER=$BENUTZER
ExecStart=/usr/local/bin/bar-display-reset

[Install]
WantedBy=multi-user.target
RESET
sudo systemctl daemon-reload
sudo systemctl enable bar-display-reset.service >/dev/null 2>&1 || true
sudo BENUTZER="$BENUTZER" /usr/local/bin/bar-display-reset >/dev/null 2>&1 || true
sudo tee /etc/sudoers.d/bar-display >/dev/null <<SUDO
# Der Dienst darf genau diese zwei Helfer als root aufrufen (bar-display)
$BENUTZER ALL=(root) NOPASSWD: /usr/local/bin/bar-display-uhr, /usr/local/bin/bar-display-ap
SUDO
sudo chmod 0440 /etc/sudoers.d/bar-display
sudo visudo -cf /etc/sudoers.d/bar-display >/dev/null || { sudo rm -f /etc/sudoers.d/bar-display; warne "sudo-Regel fehlerhaft - Helfer nicht freigegeben."; }

# Die Touch-Anzeige am DSI-Anschluss: ihr Touch soll auf sie zeigen, nicht auf
# die ganze Flaeche beider Bildschirme. Das rechnet pi/touch.sh bei jedem
# Start vor der Anzeige aus (siehe dort, warum nicht WL_OUTPUT).
sudo install -m 0755 "$ZIEL/pi/touch.sh" /usr/local/bin/bar-display-touch
sudo tee /etc/systemd/system/bar-display-touch.service >/dev/null <<'TOUCH'
[Unit]
Description=Bar Display - Touch-Bildschirm auf seinen Platz legen
Before=bar-display-kiosk.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/bar-display-touch

[Install]
WantedBy=multi-user.target
TOUCH
sudo systemctl daemon-reload
sudo systemctl enable --now bar-display-touch.service >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
if [ "$AP" = "ja" ] && [ "$KIOSK_ART" = "konsole" ] && command -v nmcli >/dev/null 2>&1; then
  sage "Funkzugang (Access Point) einrichten"
  # Ohne Land bleibt der Funk auf einem Pi gesperrt.
  if command -v raspi-config >/dev/null 2>&1; then
    sudo raspi-config nonint do_wifi_country "$WLAN_LAND" >/dev/null 2>&1 || true
  fi
  sudo rfkill unblock wifi >/dev/null 2>&1 || true
  sudo nmcli radio wifi on >/dev/null 2>&1 || true

  # Anmeldefenster: die Adressen, unter denen Handys nachsehen, ob sie online
  # sind, zeigen auf dieses Geraet - die Antwort darauf oeffnet die Bedienseite
  # (lib/webserver.js). Alles andere loest dnsmasq wie gewohnt auf, ein Handy
  # im Funkzugang kommt also weiter ins Netz, wenn das Geraet am Kabel haengt.
  sudo mkdir -p /etc/NetworkManager/dnsmasq-shared.d
  sudo tee /etc/NetworkManager/dnsmasq-shared.d/bar-display.conf >/dev/null <<'DNS'
# bar-display: Online-Pruefungen der Handys landen hier (Anmeldefenster)
address=/connectivitycheck.gstatic.com/10.42.0.1
address=/connectivitycheck.android.com/10.42.0.1
address=/clients3.google.com/10.42.0.1
address=/captive.apple.com/10.42.0.1
address=/www.msftconnecttest.com/10.42.0.1
address=/www.msftncsi.com/10.42.0.1
address=/detectportal.firefox.com/10.42.0.1
address=/nmcheck.gnome.org/10.42.0.1
address=/networkcheck.kde.org/10.42.0.1
# und ein paar Namen, die man am Handy tippen kann
address=/plakat/10.42.0.1
address=/plakat.local/10.42.0.1
address=/anzeige/10.42.0.1
address=/bar-display/10.42.0.1
DNS

  # Beim ersten Mal: offener Zugang, SSID nach dem Geraetenamen. Wer ihn schon
  # eingerichtet hat, behaelt seine Einstellung - die steht in NetworkManager.
  if [ ! -f /etc/NetworkManager/system-connections/bar-display-ap.nmconnection ]; then
    if sudo /usr/local/bin/bar-display-ap anwenden offen "$(hostname | tr '[:lower:]' '[:upper:]' | cut -c1-32)" >/dev/null 2>&1; then
      echo "Offener Funkzugang \"$(hostname | tr '[:lower:]' '[:upper:]')\" eingeschaltet - Adresse 10.42.0.1"
    else
      warne "Funkzugang liess sich nicht einschalten (kein WLAN?). Spaeter auf der Bedienseite unter System."
    fi
  fi
fi

# ---------------------------------------------------------------------------
sage "Aktualisierungsbefehl anlegen"
sudo tee /usr/local/bin/bar-display-update >/dev/null <<'AKTUELL'
#!/usr/bin/env bash
set -euo pipefail
if [ -d /opt/bar-display/.git ]; then
  sudo git -C /opt/bar-display fetch --depth 1 origin main
  sudo git -C /opt/bar-display reset --hard origin/main
else
  echo "Kein Git in /opt/bar-display - das Programm wurde von Hand hinueberkopiert (pi/sync.sh)."
fi
# Das Startskript der Anzeige liegt ausserhalb des Repos und muss mit
sudo install -m 0755 /opt/bar-display/pi/kiosk.sh /usr/local/bin/bar-display-kiosk
. /etc/default/bar-display 2>/dev/null || KIOSK_ART=konsole
sudo systemctl restart bar-display.service
if [ "${KIOSK_ART:-konsole}" = "desktop" ]; then
  echo "Die Anzeige laeuft in der Sitzung - fuer die neue Fassung:"
  echo "    bar-display-konsole && bar-display-anzeige"
else
  sudo systemctl restart bar-display-kiosk.service
fi
echo "Bar Display aktualisiert."
echo "Hinweis: Aendert sich einmal etwas an den Diensten selbst, hilft nur ein"
echo "erneuter Lauf des Einrichtungsskripts - das steht dann in den Hinweisen."
AKTUELL
sudo chmod +x /usr/local/bin/bar-display-update

# Zurueck zur Eingabeaufforderung und wieder zur Anzeige. Ohne diese beiden
# Befehle muesste man sich merken, dass der automatische Login nach dem Stoppen
# der Anzeige nicht von allein zurueckkommt - Conflicts beendet ihn, startet ihn
# aber nicht wieder.
sudo tee /usr/local/bin/bar-display-konsole >/dev/null <<'KONSOLE'
#!/usr/bin/env bash
set -euo pipefail
. /etc/default/bar-display 2>/dev/null || KIOSK_ART=konsole
PORT="${PORT:-8080}"
PORTAL_PORT="${PORTAL_PORT:-80}"
# Eigener Funkzugang (Access Point) fuer Handys: ja/nein, und das Land fuer den Funk
AP="${AP:-ja}"
WLAN_LAND="${WLAN_LAND:-DE}"

if [ "${KIOSK_ART:-konsole}" = "desktop" ]; then
  # Kein Dienst, den man anhalten koennte - die Anzeige laeuft in der Sitzung.
  pkill -f "kiosk http://localhost:$PORT/" || true
  echo "Anzeige angehalten. Die Arbeitsflaeche ist wieder frei."
else
  sudo systemctl stop bar-display-kiosk.service
  sudo systemctl start getty@tty1.service
  echo "Anzeige angehalten, Eingabeaufforderung ist zurueck."
fi
echo "Wieder anzeigen mit: bar-display-anzeige"
KONSOLE
sudo chmod +x /usr/local/bin/bar-display-konsole

sudo tee /usr/local/bin/bar-display-anzeige >/dev/null <<'ANZEIGE'
#!/usr/bin/env bash
set -euo pipefail
. /etc/default/bar-display 2>/dev/null || KIOSK_ART=konsole

if [ "${KIOSK_ART:-konsole}" = "desktop" ]; then
  # Muss aus der Sitzung heraus starten - von einer Textkonsole aus fehlt der
  # Bildschirm. Deshalb hier kein sudo und kein systemd.
  if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    echo "Bitte in einem Fenster der Arbeitsflaeche ausfuehren, nicht ueber SSH." >&2
    echo "Oder einfach ab- und wieder anmelden - die Anzeige startet mit." >&2
    exit 1
  fi
  setsid env KIOSK_ART=desktop PORT="${PORT:-8080}" \
    /usr/local/bin/bar-display-kiosk >/dev/null 2>&1 &
else
  sudo systemctl start bar-display-kiosk.service
fi
echo "Anzeige laeuft wieder."
ANZEIGE
sudo chmod +x /usr/local/bin/bar-display-anzeige

# ---------------------------------------------------------------------------
ADRESSE="$(hostname -I 2>/dev/null | awk '{print $1}')"

# Kurz Zeit geben, der erste Abgleich braucht ein paar Sekunden
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ] && break
  sleep 1
done
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ]; then
  ZEITLAGE="Uhrzeit aus dem Netz abgeglichen: $(date '+%d.%m.%Y %H:%M')"
else
  ZEITLAGE="ACHTUNG: Uhrzeit noch nicht abgeglichen ($(date '+%d.%m.%Y %H:%M')).
  Ohne richtige Uhr greifen Timetable, Zeitfenster, Ruhezeit und geplante
  Durchsagen zur falschen Stunde. Pruefen mit: timedatectl status"
fi

if [ "$DIENST_OK" = nein ] || [ "$KIOSK_OK" = nein ]; then
  LAGE="ACHTUNG: "
  [ "$DIENST_OK" = nein ] && LAGE="${LAGE}Der Webdienst ist nicht gestartet. "
  [ "$KIOSK_OK" = nein ] && LAGE="${LAGE}Die Vollbildanzeige ist nicht gestartet. "
  LAGE="${LAGE}
  Alles andere ist eingerichtet. Ursache ansehen mit:
      systemctl status bar-display.service --no-pager -l
      journalctl -u bar-display -n 50 --no-pager
      journalctl -u bar-display-kiosk -n 50 --no-pager"
else
  LAGE="Anzeige laeuft auf dem angeschlossenen Bildschirm."
fi

# Auf dem Pi ist SSH ab Werk aus und wird ueber raspi-config eingeschaltet;
# anderswo laeuft es meist schon.
SSH_HINWEIS=""
[ "$IST_PI" -eq 1 ] && SSH_HINWEIS='Auf dem Pi ist SSH ab Werk aus - einschalten mit "sudo raspi-config" unter Interface Options.'

[ -n "${I2C_HINWEIS:-}" ] && warne "$I2C_HINWEIS"
sage "Fertig"
cat <<ENDE

  $LAGE

  Bedienung vom Handy im selben WLAN:
      http://${ADRESSE:-<IP-des-Pi>}:$PORT/einstellungen

  Videos, Fotos und Logo gehoeren nach:
      ~/.config/Bar Display/media
      ~/.config/Bar Display/photos
      ~/.config/Bar Display/branding

  $ZEITLAGE
${KONSOLE_HINWEIS:+
  $KONSOLE_HINWEIS
}${GPUMEM_HINWEIS:+
  $GPUMEM_HINWEIS
}${BOOT_HINWEIS:+
  $BOOT_HINWEIS
}
  Nuetzliche Befehle:
      bar-display-konsole                      Anzeige anhalten, Konsole zurueck
      bar-display-anzeige                      Anzeige wieder starten
      bar-display-update                       neue Fassung holen
      timedatectl status                       Uhrzeit und Abgleich pruefen

  Kommt man nicht mehr an das Geraet: Strg + Alt + F2 gibt eine zweite Konsole.
  Bequemer ist SSH: ssh $BENUTZER@${ADRESSE:-<IP>}
${SSH_HINWEIS:+  $SSH_HINWEIS
}

  Laeuft die Anzeige ruckelig, hilft im Reiter "Anzeige" der Sparmodus.
  Ob die Videodekodierung in Hardware laeuft, verraet in Chromium die
  Adresse chrome://gpu (Zeile "Video Decode").

  Nach Aenderungen am Bootbereich hilft ein Neustart:
      sudo reboot
      sudo systemctl restart bar-display       Dienst neu starten
      journalctl -u bar-display -f             Protokoll ansehen
      journalctl -u bar-display-kiosk -f       Protokoll der Anzeige

ENDE
