# Harbor Pointe Creates

The friends-and-family 3D printing side of Harbor Pointe. A public page where
people request a print and pick a color, a package-style tracking page with live
printer progress and camera shots, and a private admin console (a small CMS)
for working the queue, emailing status updates, and logging filament and time.

Sibling of [harbor-pointe-designs](https://github.com/BookOnTape/harbor-pointe-designs):
same stack, same type family, new palette and layout.

## Stack

- **Astro 5** — static pages in `src/`, zero client JS except the form, the
  tracking page, and the admin app.
- **Cloudflare Workers (static assets)** — hosting, auto-deploy on push.
- **Worker** (`worker/`) — the API: submissions, tracking, admin CRUD, stats,
  printer progress ingest. Runs on every request so it can gate `/admin`.
- **Cloudflare D1** — SQLite database (`migrations/`). Requests, timeline
  events, print logs, webcam snapshots, settings.
- **Resend** — transactional email (confirmation, status updates, notes).
- **Cloudflare Access** (optional, recommended) — login wall for `/admin`,
  same as HQ. Falls back to a bearer `ADMIN_TOKEN`.
- **Printer bridge** (`bridge/`) — a small Python script that runs on your LAN,
  polls the printer, and posts progress + snapshots to the site.

Everything above is on Cloudflare's free tier at this scale.

## Pages

| Path | What |
| --- | --- |
| `/` | Hero, how it works, request form, "where the good files live" directory, FAQ |
| `/track?t=<token>` | Public tracking page. The token is in the confirmation email. |
| `/admin` | Board / list / stats console. Gated. |

## Request lifecycle

`received → reviewing → queued → printing → finishing → ready → delivered`,
plus `on_hold` and `declined` as side states. Labels, blurbs, and order live in
`shared/statuses.js` and drive the emails, the tracking timeline, and the admin
board. Change copy there once and it changes everywhere.

## Local development

```bash
nvm use            # Node 22
npm install
cp .dev.vars.example .dev.vars   # local ADMIN_TOKEN / PRINTER_TOKEN
npm run db:migrate:local         # creates the local D1 database
npm run cf:preview               # astro build && wrangler dev → http://127.0.0.1:8787
```

`npm run dev` (Astro only, port 4321) is fine for styling the public page, but
the form, tracking, and admin need the Worker, so use `cf:preview` for those.
Without `RESEND_API_KEY` emails are printed to the Wrangler console instead of
sent, and the admin shows a banner saying so.

To see the tracking page light up before a real printer is wired in:

```bash
pip install -r bridge/requirements.txt
cp bridge/config.example.yaml bridge/config.yaml   # set kind: demo, url: http://127.0.0.1:8787
python3 bridge/bridge.py
```

Then in `/admin` open a request, flip **This is the job on the printer**, set
status to **Printing**, and watch `/track?t=…` for that request.

## Deploy (first time)

1. **Create the database and note its id.**
   ```bash
   npx wrangler d1 create harbor-pointe-creates
   ```
   Paste the `database_id` into `wrangler.jsonc`, then:
   ```bash
   npm run db:migrate
   ```
2. **Secrets.** Each one: `npx wrangler secret put NAME` (or Worker → Settings → Variables and Secrets).
   - `RESEND_API_KEY` — from Resend. `CONTACT_FROM` in `wrangler.jsonc` must be a verified sender on your domain.
   - `PRINTER_TOKEN` — any long random string; the bridge sends it as a bearer token.
   - `ADMIN_TOKEN` — a long random string. Break-glass login for `/admin`, and the only login if you skip Access.
   - `ACCESS_AUD` — only if using Cloudflare Access (step 4).
3. **Deploy.**
   ```bash
   npm run deploy
   ```
   Or connect the repo in Cloudflare → Workers & Pages → Create → Workers →
   Connect to Git (build command `npm run build`, deploy command
   `npx wrangler deploy`) for deploy-on-push, like the Designs site.
4. **Login wall (recommended).** Cloudflare → Zero Trust → Access → Applications →
   Add → Self-hosted. Domain: your site, path `admin` (add a second one for
   `api/admin`). Policy: Allow → Emails → yours. On the application's overview
   copy the **Application Audience (AUD) tag** into the `ACCESS_AUD` secret and
   set `ACCESS_TEAM_DOMAIN` in `wrangler.jsonc` to your team domain
   (`<team>.cloudflareaccess.com`). Redeploy. The Worker verifies the Access
   JWT on every admin request, so even a misconfigured Access rule fails closed.
5. **Custom domain.** Worker → Settings → Domains & Routes → add
   `creates.harborpointedesigns.com`. Update `site` in `astro.config.mjs` if
   you pick something else.

## The printer bridge

`bridge/bridge.py` runs anywhere on the same network as the printer (your Mac,
a Raspberry Pi, the OctoPrint Pi). Every `poll_seconds` it asks the site which
request is "on the printer" (you set that in admin), reads progress from the
printer, and posts it back, with a downscaled webcam JPEG every
`snapshot_every_seconds`.

Adapters:

| `kind` | Status | Camera |
| --- | --- | --- |
| `elegoo` | Centauri Carbon 2 (JSON-RPC over MQTT `:1883`, access code) and Centauri Carbon (SDCP `:3030`), via [pycentauri](https://pypi.org/project/pycentauri/) | The printer's own MJPEG stream (`:8080` on CC2, `:3031` on CC1) |
| `moonraker` | Klipper / Mainsail / Fluidd / most Creality K-series | Moonraker's configured webcam, or `snapshot_url` |
| `octoprint` | OctoPrint REST API | `/webcam/?action=snapshot`, or `snapshot_url` |
| `bambu` | LAN MQTT (`bblp` + access code) | P1/A1: TCP-6000 stream. X1/H2: RTSP via `ffmpeg`. |
| `prusalink` | PrusaLink (MK4 / XL / Mini) | `snapshot_url` only (no camera API) |
| `demo` | Fakes a 0→100% print | Draws a placeholder frame |

**Centauri Carbon 2 setup:** on the printer, Settings → Network: turn on
**LAN Only** mode and note the **access code**. Give the printer a fixed IP on
your router. Put both in `bridge/config.yaml` under `kind: elegoo`. Without
LAN Only the local API stays closed and the bridge logs a connect timeout.
The CC2's Canvas (4-spool) system is read every few minutes and the active
tray's brand, material, and color are printed in the bridge log, which is handy
when you fill in the filament log afterwards.

Any adapter can override the camera with `snapshot_url` (a JPEG or MJPEG URL)
or `snapshot_cmd` (a shell command that writes a JPEG to `{out}`).

Run it as a service so it survives reboots: on a Pi, a `systemd` unit; on a
Mac, a `launchd` plist or just a terminal tab. Frames are kept per request
(last 10) and only shown to the requester when **Share camera** is on for that
request.

## Project structure

```
src/
  layouts/Base.astro          <head>, fonts, meta
  pages/index.astro           public page
  pages/track.astro           tracking page (client-rendered from /api/track)
  pages/admin/index.astro     admin console shell + styles
  pages/404.astro
  scripts/admin.ts            admin app logic
  components/                 Hero, Nav, Wordmark, Strip, HowItWorks,
                              RequestForm, Sources, Faq, Footer
  data/sources.js             the file-site directory (add a site = add an entry)
  styles/global.css           design tokens + base
shared/statuses.js            the request lifecycle (shared by site + Worker)
worker/
  index.js                    router + handlers
  auth.js                     Cloudflare Access JWT verify, ADMIN_TOKEN, PRINTER_TOKEN
  email.js                    Resend + templates
  util.js
migrations/0001_init.sql      D1 schema
bridge/                       printer bridge (Python)
wrangler.jsonc                Worker config: assets, D1 binding, non-secret vars
```

## API (for reference)

Public: `POST /api/requests`, `GET /api/track/:token`, `GET /api/track/:token/snapshot`.
Admin (Access cookie or `Authorization: Bearer ADMIN_TOKEN`): `GET /api/admin/requests`,
`GET|PATCH|DELETE /api/admin/requests/:id`, `POST …/:id/message`, `POST …/:id/logs`,
`DELETE /api/admin/logs/:id`, `GET …/:id/snapshot`, `GET /api/admin/stats`, `GET|PUT /api/admin/settings`.
Printer (`Authorization: Bearer PRINTER_TOKEN`): `GET /api/printer/current`, `POST /api/printer/progress`.

## Not built (yet)

- **File upload.** The form takes a link; files come by email reply. Adding
  upload means an R2 bucket and a size cap. Worth it if links prove annoying.
- **SMS.** Email only. Twilio would drop into `worker/email.js` easily.
- **Multiple printers at once.** One "current job" pointer. A second printer
  means a `printer_id` on the pointer and in the bridge config.
