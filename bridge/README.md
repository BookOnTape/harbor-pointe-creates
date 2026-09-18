# Printer bridge

Polls your printer and posts progress + webcam frames to the site. See the
main README for the full picture; this is the short version.

```bash
cd bridge
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp config.example.yaml config.yaml    # edit: site url, printer token, printer block
python3 bridge.py --once              # one poll, prints what it would send
python3 bridge.py                     # loop
```

`config.yaml` is git-ignored because it holds the printer token and access code.

## Where it runs: joecool (the Beelink), as a container

Decided 2026-09-18. Not BeagleScout: that board's job is to never change (it is
the DNS fallback and the thing that reports joecool down), and the bridge has
no reason to live next to Homebridge. joecool already has Docker with capped
logging, CasaOS tiles, the graceful-shutdown script, and a Claude Code session
that can reach the printer for testing.

```bash
# on joecool, once
gh repo clone BookOnTape/harbor-pointe-creates ~/projects/harbor-pointe-creates
sudo mkdir -p /DATA/AppData/hpc-bridge
sudo cp ~/projects/harbor-pointe-creates/bridge/config.example.yaml /DATA/AppData/hpc-bridge/config.yaml
sudo chmod 600 /DATA/AppData/hpc-bridge/config.yaml
sudoedit /DATA/AppData/hpc-bridge/config.yaml     # printer IP, access code, site url + printer_token

cd ~/projects/harbor-pointe-creates/bridge
docker compose up -d --build
docker logs -f hpc-bridge                           # expect: "elegoo connected: CC2Printer at <ip>"
```

The container has no ports, no media-drive mounts, and nothing to back up; the
config file is the only state and it holds two secrets, hence the `600`.
`restart: unless-stopped` brings it back after joecool's reboots, and the site
keeps the last known progress while it is down. Give the printer a DHCP
reservation on the Fios router first and name it in AdGuard on both instances
(`APP-Office-CentauriCarbon2` fits the scheme in `media/docs/home-network-devices.md`).

To run it bare instead of in Docker, see the venv block below.

## Elegoo Centauri Carbon 2 notes

- Settings → Network on the touchscreen: enable **LAN Only** and copy the
  **access code**. The bridge uses MQTT on port 1883 (user `elegoo`, password
  = access code) and the camera on port 8080. No cloud account involved.
- `python3 bridge.py --once` should log `elegoo connected: CC2Printer at <ip>`
  followed by a state line. A connect timeout almost always means LAN Only is
  off or the IP changed; a "connection refused" means the access code is wrong.
- The original Centauri Carbon works with the same `kind: elegoo` block and no
  access code.
- pycentauri is alpha and tracks Elegoo firmware changes closely. If a
  firmware update breaks status, `pip install -U pycentauri` first.

## Bambu Lab notes

- LAN mode is not required, but the printer must be reachable on your LAN.
  MQTT is on port 8883, user `bblp`, password is the access code on the
  printer's screen (Settings → WLAN → Access Code).
- P1P / P1S / A1 / A1 mini cameras use a proprietary TLS stream on port 6000.
  The implementation follows the community-documented framing; it is the least
  battle-tested part of this script. If frames never arrive, run
  `python3 bridge.py --once` and read the log, then fall back to `snapshot_cmd`.
- X1 / X1C / H2 cameras are RTSP. Install `ffmpeg` and the bridge grabs a
  frame with it.

## Run it at boot (Raspberry Pi)

`/etc/systemd/system/hpc-bridge.service`:

```ini
[Unit]
Description=Harbor Pointe Creates printer bridge
After=network-online.target

[Service]
WorkingDirectory=/home/pi/harbor-pointe-creates/bridge
ExecStart=/home/pi/harbor-pointe-creates/bridge/.venv/bin/python bridge.py
Restart=always
RestartSec=10
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now hpc-bridge
journalctl -u hpc-bridge -f
```
