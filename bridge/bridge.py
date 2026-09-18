#!/usr/bin/env python3
"""
Harbor Pointe Creates — printer bridge.

Runs next to the printer (same LAN), polls it for job progress, grabs a webcam
frame now and then, and POSTs both to the site so the requester's tracking page
shows "64% · ~1h 40m left" with a live photo, like a package on a truck.

The Worker decides *which* request the progress belongs to: in the admin
console you flip "This is the job on the printer" on a request. The bridge just
reports what the printer says. If nothing is marked current, it idles.

    python3 bridge.py            # uses ./config.yaml
    python3 bridge.py -c other.yaml --once   # single poll, handy for testing

Adapters: elegoo (Centauri Carbon 1/2), moonraker (Klipper), octoprint,
bambu (MQTT + camera), prusalink, demo.
Camera fallbacks for any printer: snapshot_url (JPEG over HTTP) or snapshot_cmd.
"""
import argparse
import base64
import io
import json
import os
import shlex
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
from typing import Optional

import requests

try:
    import yaml
except ImportError:  # pragma: no cover
    print("pip install -r requirements.txt", file=sys.stderr)
    raise


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def shrink_jpeg(data: bytes, max_width: int, quality: int) -> bytes:
    """Downscale + recompress so a frame stays well under the Worker's limit."""
    try:
        from PIL import Image
    except ImportError:
        return data
    try:
        im = Image.open(io.BytesIO(data))
        im = im.convert("RGB")
        if im.width > max_width:
            h = int(im.height * max_width / im.width)
            im = im.resize((max_width, h))
        out = io.BytesIO()
        im.save(out, "JPEG", quality=quality, optimize=True)
        return out.getvalue()
    except Exception as e:  # noqa: BLE001
        log("shrink failed:", e)
        return data


def http_jpeg(url: str, auth=None, headers=None, timeout=10) -> Optional[bytes]:
    try:
        r = requests.get(url, auth=auth, headers=headers, timeout=timeout)
        r.raise_for_status()
        ct = r.headers.get("Content-Type", "")
        if "multipart" in ct:
            # MJPEG stream: take the first frame
            body = r.content
            start = body.find(b"\xff\xd8")
            end = body.find(b"\xff\xd9", start)
            return body[start : end + 2] if start >= 0 and end > 0 else None
        return r.content
    except Exception as e:  # noqa: BLE001
        log("snapshot fetch failed:", e)
        return None


def cmd_jpeg(cmd: str, timeout=20) -> Optional[bytes]:
    fd, path = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    try:
        subprocess.run(shlex.split(cmd.format(out=shlex.quote(path))), timeout=timeout, check=True)
        with open(path, "rb") as f:
            return f.read()
    except Exception as e:  # noqa: BLE001
        log("snapshot_cmd failed:", e)
        return None
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Adapters. Each returns a dict:
#   {state: printing|paused|complete|error|idle, percent: float|None,
#    eta_seconds: int|None, file: str|None}
# and snapshot() -> bytes|None
# ---------------------------------------------------------------------------
class Moonraker:
    def __init__(self, cfg):
        self.base = cfg["host"].rstrip("/")
        self.headers = {"X-Api-Key": cfg["api_key"]} if cfg.get("api_key") else {}
        self.snapshot_url = cfg.get("snapshot_url") or None

    def status(self):
        q = "print_stats&display_status&virtual_sdcard"
        r = requests.get(f"{self.base}/printer/objects/query?{q}", headers=self.headers, timeout=8)
        r.raise_for_status()
        s = r.json()["result"]["status"]
        ps = s.get("print_stats", {})
        state_map = {"printing": "printing", "paused": "paused", "complete": "complete", "error": "error", "cancelled": "cancelled", "standby": "idle"}
        state = state_map.get(ps.get("state"), "idle")
        pct = s.get("virtual_sdcard", {}).get("progress")
        pct = round(float(pct) * 100, 1) if pct is not None else None
        eta = None
        dur = ps.get("print_duration") or 0
        if state == "printing" and pct and pct > 1:
            eta = int(dur * (100 - pct) / pct)
        return {"state": state, "percent": pct, "eta_seconds": eta, "file": ps.get("filename") or None}

    def snapshot(self):
        url = self.snapshot_url
        if not url:
            try:
                r = requests.get(f"{self.base}/server/webcams/list", headers=self.headers, timeout=8)
                cams = r.json()["result"]["webcams"]
                if cams:
                    url = cams[0].get("snapshot_url") or ""
                    if url.startswith("/"):
                        url = self.base + url
            except Exception as e:  # noqa: BLE001
                log("webcam list failed:", e)
        return http_jpeg(url, headers=self.headers) if url else None


class OctoPrint:
    def __init__(self, cfg):
        self.base = cfg["host"].rstrip("/")
        self.headers = {"X-Api-Key": cfg["api_key"]}
        self.snapshot_url = cfg.get("snapshot_url") or f"{self.base}/webcam/?action=snapshot"

    def status(self):
        r = requests.get(f"{self.base}/api/job", headers=self.headers, timeout=8)
        r.raise_for_status()
        j = r.json()
        st = (j.get("state") or "").lower()
        if "printing" in st:
            state = "printing"
        elif "paus" in st:
            state = "paused"
        elif "error" in st:
            state = "error"
        elif "operational" in st and (j.get("progress", {}).get("completion") or 0) >= 100:
            state = "complete"
        else:
            state = "idle"
        pr = j.get("progress", {})
        pct = pr.get("completion")
        return {
            "state": state,
            "percent": round(float(pct), 1) if pct is not None else None,
            "eta_seconds": pr.get("printTimeLeft"),
            "file": (j.get("job", {}).get("file") or {}).get("name"),
        }

    def snapshot(self):
        return http_jpeg(self.snapshot_url)


class PrusaLink:
    def __init__(self, cfg):
        self.base = cfg["host"].rstrip("/")
        self.auth = requests.auth.HTTPDigestAuth(cfg["username"], cfg["password"])
        self.snapshot_url = cfg.get("snapshot_url") or None

    def status(self):
        r = requests.get(f"{self.base}/api/v1/status", auth=self.auth, timeout=8)
        r.raise_for_status()
        j = r.json()
        st = (j.get("printer", {}).get("state") or "").upper()
        state = {"PRINTING": "printing", "PAUSED": "paused", "FINISHED": "complete", "ERROR": "error", "ATTENTION": "paused"}.get(st, "idle")
        job = j.get("job") or {}
        return {
            "state": state,
            "percent": job.get("progress"),
            "eta_seconds": job.get("time_remaining"),
            "file": (job.get("file") or {}).get("display_name") or (job.get("file") or {}).get("name"),
        }

    def snapshot(self):
        return http_jpeg(self.snapshot_url) if self.snapshot_url else None


class Bambu:
    """
    Bambu Lab over LAN. Status via MQTT (port 8883, user 'bblp', password =
    access code). Camera:
      - P1P / P1S / A1 / A1 mini: proprietary JPEG stream on TCP 6000 (TLS)
      - X1 / X1C / H2: RTSP on port 322 (needs ffmpeg on PATH)
    [Guessing]-grade on the 6000 protocol details; it's the same framing the
    OctoEverywhere / bambu-connect community tools use. If frames don't come
    through, set `snapshot_cmd` / `snapshot_url` instead.
    """

    def __init__(self, cfg):
        import paho.mqtt.client as mqtt  # noqa: WPS433

        self.host = cfg["host"]
        self.serial = cfg["serial"]
        self.code = str(cfg["access_code"])
        self.camera = cfg.get("camera", "auto")
        self._last = {"state": "idle", "percent": None, "eta_seconds": None, "file": None}
        self._lock = threading.Lock()

        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"hpc-bridge-{int(time.time())}")
        self.client.username_pw_set("bblp", self.code)
        self.client.tls_set(cert_reqs=ssl.CERT_NONE)
        self.client.tls_insecure_set(True)
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.connect_async(self.host, 8883, keepalive=60)
        self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        log("bambu mqtt connected", reason_code)
        client.subscribe(f"device/{self.serial}/report")
        # Ask for a full status dump.
        client.publish(f"device/{self.serial}/request", json.dumps({"pushing": {"sequence_id": "0", "command": "pushall"}}))

    def _on_message(self, client, userdata, msg):
        try:
            data = json.loads(msg.payload)
        except Exception:  # noqa: BLE001
            return
        p = data.get("print")
        if not p:
            return
        with self._lock:
            gs = (p.get("gcode_state") or "").upper()
            if gs:
                self._last["state"] = {"RUNNING": "printing", "PAUSE": "paused", "FINISH": "complete", "FAILED": "error", "IDLE": "idle", "PREPARE": "printing", "SLICING": "printing"}.get(gs, "idle")
            if "mc_percent" in p:
                self._last["percent"] = float(p["mc_percent"])
            if "mc_remaining_time" in p:
                self._last["eta_seconds"] = int(p["mc_remaining_time"]) * 60
            if p.get("subtask_name"):
                self._last["file"] = p["subtask_name"]

    def status(self):
        with self._lock:
            return dict(self._last)

    def snapshot(self):
        cam = self.camera
        if cam == "none":
            return None
        if cam == "x1" or cam == "auto":
            data = self._rtsp_frame()
            if data or cam == "x1":
                return data
        return self._p1_frame()

    def _rtsp_frame(self):
        url = f"rtsps://bblp:{self.code}@{self.host}:322/streaming/live/1"
        return cmd_jpeg(f"ffmpeg -y -loglevel error -rtsp_transport tcp -i {shlex.quote(url)} -frames:v 1 {{out}}", timeout=25)

    def _p1_frame(self):
        """P1/A1 camera: TLS to :6000, send auth packet, read framed JPEGs."""
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            raw = socket.create_connection((self.host, 6000), timeout=10)
            s = ctx.wrap_socket(raw, server_hostname=self.host)
            user = b"bblp".ljust(32, b"\x00")
            code = self.code.encode().ljust(32, b"\x00")
            auth = struct.pack("<IIII", 0x40, 0x3000, 0, 0) + user + code
            s.sendall(auth)
            buf = b""
            deadline = time.time() + 10
            while time.time() < deadline:
                chunk = s.recv(65536)
                if not chunk:
                    break
                buf += chunk
                if len(buf) >= 16:
                    (length,) = struct.unpack("<I", buf[:4])
                    if len(buf) >= 16 + length:
                        frame = buf[16 : 16 + length]
                        s.close()
                        return frame if frame.startswith(b"\xff\xd8") else None
            s.close()
        except Exception as e:  # noqa: BLE001
            log("bambu p1 camera failed:", e)
        return None



class Demo:
    """Fake printer that walks 0→100% over `minutes` and paints a placeholder
    frame. Use it to see the tracking page working before wiring a real printer:
        printer: {kind: demo, minutes: 5}
    """

    def __init__(self, cfg):
        self.start = time.time()
        self.total = float(cfg.get("minutes", 5)) * 60

    def status(self):
        elapsed = time.time() - self.start
        pct = min(100.0, round(elapsed / self.total * 100, 1))
        return {"state": "complete" if pct >= 100 else "printing", "percent": pct, "eta_seconds": int(max(0, self.total - elapsed)), "file": "demo-benchy.3mf"}

    def snapshot(self):
        try:
            from PIL import Image, ImageDraw
        except ImportError:
            return None
        im = Image.new("RGB", (640, 360), (11, 26, 33))
        d = ImageDraw.Draw(im)
        pct = self.status()["percent"]
        d.rectangle([40, 300, 40 + int(560 * pct / 100), 320], fill=(255, 122, 69))
        d.rectangle([40, 300, 600, 320], outline=(127, 205, 184))
        d.text((40, 40), f"DEMO PRINTER  {pct}%", fill=(238, 240, 234))
        out = io.BytesIO()
        im.save(out, "JPEG", quality=80)
        return out.getvalue()


class Elegoo:
    """
    Elegoo Centauri Carbon (CC1) and Centauri Carbon 2 (CC2) via pycentauri,
    which auto-detects the model. The CC2 speaks JSON-RPC over MQTT on :1883
    with the access code from the printer screen as the password, and serves
    an MJPEG stream on :8080. The CC1 is SDCP over WebSocket on :3030 with
    MJPEG on :3031 and no auth.

    CC2: turn on "LAN Only" mode in the printer's network settings first,
    otherwise the local API stays closed and you get a connect timeout.

    pycentauri is async; the bridge is not, so the client lives on a private
    event loop in a background thread and reconnects itself after errors.
    """

    # PrintInfo.Status codes (pycentauri.models.PrintStatus) → bridge states
    _STATE = {
        0: "idle", 5: "paused", 6: "paused", 12: "paused",
        7: "cancelled", 8: "cancelled", 9: "complete", 14: "error",
        27: "filament swap", 28: "filament swap", 29: "filament swap",
    }

    def __init__(self, cfg):
        import asyncio

        self.host = cfg["host"]
        self.code = str(cfg.get("access_code", "") or "")
        self._printer = None
        self._loop = asyncio.new_event_loop()
        threading.Thread(target=self._loop.run_forever, name="elegoo-loop", daemon=True).start()
        self._last_canvas_log = 0.0

    def _run(self, coro, timeout=30):
        import asyncio

        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(timeout)

    async def _ensure(self):
        if self._printer is not None:
            return self._printer
        from pycentauri.connect import connect_auto

        self._printer = await connect_auto(self.host, access_code=self.code or None, connect_timeout=10)
        log(f"elegoo connected: {type(self._printer).__name__} at {self.host}")
        return self._printer

    async def _drop(self):
        p, self._printer = self._printer, None
        if p is not None:
            try:
                await p.close()
            except Exception:  # noqa: BLE001
                pass

    async def _status(self):
        p = await self._ensure()
        st = await p.status()
        code = st.print_status if st.print_status is not None else 0
        state = self._STATE.get(code, "printing")
        pct = float(st.progress) if st.progress is not None else None
        pi = st.print_info
        eta = None
        cc2 = st.raw.get("_cc2") if isinstance(st.raw, dict) else None
        if cc2 and cc2.get("remaining_time_sec") is not None:
            eta = int(cc2["remaining_time_sec"])
        elif pi and pi.total_ticks and pi.current_ticks is not None:
            eta = int(max(0, pi.total_ticks - pi.current_ticks))
        if state == "idle" and pct and 0 < pct < 100 and (st.filename or ""):
            state = "printing"  # firmware blips idle between sub-states
        out = {"state": state, "percent": pct, "eta_seconds": eta, "file": st.filename or None}
        if pi and pi.current_layer is not None and pi.total_layer:
            out["layer"] = f"{pi.current_layer}/{pi.total_layer}"
        # Log which Canvas tray is feeding, every few minutes, so the console
        # shows material + color for the filament log later.
        if hasattr(p, "canvas_status") and time.time() - self._last_canvas_log > 300 and state == "printing":
            try:
                cs = await p.canvas_status()
                for unit in cs.canvas_list:
                    for t in unit.tray_list:
                        if t.tray_id == cs.active_tray_id and t.status:
                            log(f"canvas tray {t.tray_id}: {t.brand} {t.filament_type} {t.filament_color}".strip())
                self._last_canvas_log = time.time()
            except Exception as e:  # noqa: BLE001
                log("canvas status failed:", e)
        return out

    def status(self):
        try:
            return self._run(self._status())
        except Exception as e:  # noqa: BLE001
            log("elegoo status failed, will reconnect:", e)
            try:
                self._run(self._drop(), timeout=10)
            except Exception:  # noqa: BLE001
                pass
            return None  # skip this poll rather than report a false "idle"

    async def _snapshot(self):
        p = await self._ensure()
        return await p.snapshot(timeout=15)

    def snapshot(self):
        try:
            return self._run(self._snapshot(), timeout=25)
        except Exception as e:  # noqa: BLE001
            log("elegoo snapshot failed:", e)
            return None

ADAPTERS = {"demo": Demo, "elegoo": Elegoo, "moonraker": Moonraker, "octoprint": OctoPrint, "bambu": Bambu, "prusalink": PrusaLink}


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
class Site:
    def __init__(self, cfg):
        self.url = cfg["url"].rstrip("/")
        self.headers = {"Authorization": f"Bearer {cfg['printer_token']}", "Content-Type": "application/json"}

    def current(self):
        r = requests.get(f"{self.url}/api/printer/current", headers=self.headers, timeout=10)
        r.raise_for_status()
        return r.json().get("request")

    def progress(self, payload):
        r = requests.post(f"{self.url}/api/printer/progress", headers=self.headers, data=json.dumps(payload), timeout=30)
        if r.status_code >= 400:
            log("progress rejected", r.status_code, r.text[:200])
        return r.ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-c", "--config", default=os.path.join(os.path.dirname(__file__), "config.yaml"))
    ap.add_argument("--once", action="store_true", help="poll once and exit")
    args = ap.parse_args()

    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    site = Site(cfg["site"])
    pcfg = cfg["printer"]
    printer = ADAPTERS[pcfg["kind"]](pcfg)
    poll = int(cfg.get("poll_seconds", 30))
    snap_every = int(cfg.get("snapshot_every_seconds", 180))
    max_w = int(cfg.get("snapshot_max_width", 960))
    quality = int(cfg.get("snapshot_jpeg_quality", 72))
    snapshot_url = cfg.get("snapshot_url")
    snapshot_cmd = cfg.get("snapshot_cmd")

    last_snap = 0.0
    last_state = None
    log(f"bridge up · {pcfg['kind']} → {site.url}")

    while True:
        try:
            current = site.current()
            st = printer.status()
            if st is None:
                log("printer unreachable this poll; keeping last known progress")
            elif not current:
                if st["state"] != last_state:
                    log("printer:", st["state"], "· no current request in admin, idling")
                    last_state = st["state"]
            else:
                payload = {"request_id": current["id"], **st}
                want_snap = st["state"] in ("printing", "paused", "complete", "filament swap") and (time.time() - last_snap) >= snap_every
                if want_snap:
                    frame = None
                    if snapshot_cmd:
                        frame = cmd_jpeg(snapshot_cmd)
                    elif snapshot_url:
                        frame = http_jpeg(snapshot_url)
                    else:
                        frame = printer.snapshot()
                    if frame:
                        frame = shrink_jpeg(frame, max_w, quality)
                        payload["snapshot_b64"] = base64.b64encode(frame).decode()
                        payload["content_type"] = "image/jpeg"
                        last_snap = time.time()
                ok = site.progress(payload)
                log(f"{current['short_id']} · {st['state']} · {st['percent']}% · eta {st['eta_seconds']}s · snap={'y' if 'snapshot_b64' in payload else 'n'} · {'ok' if ok else 'FAILED'}")
                last_state = st["state"]
        except KeyboardInterrupt:
            break
        except Exception as e:  # noqa: BLE001
            log("loop error:", e)
        if args.once:
            break
        time.sleep(poll)


if __name__ == "__main__":
    main()
