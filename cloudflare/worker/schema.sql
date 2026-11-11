-- Durable filesystem store for the static deployment.
--
-- One row per VFS path, mirroring the allowlist the browser sink persists: the
-- user patch layer (settings and model routes), the session logs, the durable
-- KV root holding the workspace registry, and the workspace files themselves.
-- Directories are rows too, so an empty directory survives a round trip.
--
-- `path` is the absolute VFS path and the natural key: the sink reports
-- mutations by path, so an upsert needs no lookup. `updated_at` is
-- last-writer-wins bookkeeping — two devices editing one file converge on
-- whichever flush landed second.
CREATE TABLE IF NOT EXISTS vfs_entries (
  path       TEXT PRIMARY KEY,
  directory  INTEGER NOT NULL,
  mode       INTEGER NOT NULL,
  bytes      BLOB,
  updated_at INTEGER NOT NULL
);

-- Counters the client reads for diagnostics. A bump per applied batch makes
-- "did another device write since my last snapshot" answerable without reading
-- every row.
CREATE TABLE IF NOT EXISTS vfs_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
