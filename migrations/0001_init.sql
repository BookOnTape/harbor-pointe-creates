-- Harbor Pointe Creates — request database (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  short_id      TEXT NOT NULL UNIQUE,   -- human id, e.g. HPC-0042
  token         TEXT NOT NULL UNIQUE,   -- public tracking token (unguessable)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- who + what (from the public form)
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  title         TEXT NOT NULL,
  file_url      TEXT,
  details       TEXT,
  quantity      INTEGER NOT NULL DEFAULT 1,
  color         TEXT,
  material      TEXT,
  size_notes    TEXT,
  needed_by     TEXT,

  -- workflow (admin)
  status        TEXT NOT NULL DEFAULT 'received',
  priority      INTEGER NOT NULL DEFAULT 0,   -- 0 normal, 1 high, -1 low
  eta           TEXT,                          -- YYYY-MM-DD shown to requester
  printer       TEXT,
  admin_notes   TEXT,                          -- private
  share_camera  INTEGER NOT NULL DEFAULT 0,    -- requester may see live snapshots

  -- live progress (written by the printer bridge)
  progress      REAL,                          -- 0..100
  progress_state TEXT,                         -- printing | paused | complete | error | idle
  progress_file TEXT,
  progress_eta_seconds INTEGER,
  progress_at   TEXT,

  ip_hash       TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at DESC);

-- Every status change (and freeform update) is an event on the timeline.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status      TEXT,            -- null for a note-only update
  note        TEXT,
  public      INTEGER NOT NULL DEFAULT 1,   -- visible on the tracking page
  notified    INTEGER NOT NULL DEFAULT 0    -- an email went out for this event
);
CREATE INDEX IF NOT EXISTS idx_events_request ON events(request_id, created_at);

-- Filament + time log. One row per print job (a request may have several).
CREATE TABLE IF NOT EXISTS print_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  logged_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  printer     TEXT,
  material    TEXT,
  color       TEXT,
  grams       REAL NOT NULL DEFAULT 0,
  minutes     INTEGER NOT NULL DEFAULT 0,
  success     INTEGER NOT NULL DEFAULT 1,   -- 0 = failed print (still burned filament)
  notes       TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_request ON print_logs(request_id);

-- Webcam snapshots from the bridge. Only the last few per request are kept.
CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  taken_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  data         BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_request ON snapshots(request_id, taken_at DESC);

-- Key/value settings (which request is on the printer right now, etc).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
