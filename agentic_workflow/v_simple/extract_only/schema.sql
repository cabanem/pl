-- schema.sql — SDC corpus fact store, Milestone 1
-- SQLite 3. Build: sqlite3 facts.db < schema.sql   (or via derive.py)
--
-- Design rules this file encodes:
--   1. Every table is keyed by snapshot_id. M1 only ever queries the latest
--      snapshot, but keying now makes M2 drift-diffing a self-join instead
--      of a redesign.
--   2. derive.py is the only writer. The tool layer opens read-only:
--        sqlite3.connect("file:facts.db?mode=ro", uri=True)
--   3. Facts only. No verdicts, no contracts, no findings — those are
--      later milestones and separate storage.
--   4. Raw JSON stays out of relational columns except where it is the
--      payload itself (input_json, detail_json). Anything queried gets
--      its own column or table.

PRAGMA foreign_keys = ON;

-- One row per dump_recipes capture. source records how it got here so the
-- scheduled / webhook paths in later milestones need no schema change.
CREATE TABLE snapshots (
    snapshot_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at   TEXT    NOT NULL,             -- ISO 8601 UTC
    workspace     TEXT    NOT NULL,
    source        TEXT    NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('manual', 'scheduled', 'webhook')),
    recipe_count  INTEGER,
    notes         TEXT
);

-- Recipe identity + trigger + fingerprint. raw_path points back at the
-- snapshot JSON (GCS object or filesystem path) — the evidence trail:
-- any agent claim should be traceable fact -> row -> raw capture.
CREATE TABLE recipes (
    snapshot_id      INTEGER NOT NULL REFERENCES snapshots(snapshot_id),
    recipe_id        TEXT    NOT NULL,          -- Workato id, kept as TEXT
    name             TEXT    NOT NULL,
    project          TEXT,
    folder_id        TEXT,
    trigger_provider TEXT,
    trigger_name     TEXT,
    trigger_keyword  TEXT,
    unfinished       INTEGER NOT NULL DEFAULT 0, -- boolean
    fingerprint      TEXT,                       -- hash of normalized code tree
    step_count       INTEGER,
    raw_path         TEXT,
    PRIMARY KEY (snapshot_id, recipe_id)
);
CREATE INDEX idx_recipes_name ON recipes (snapshot_id, name);

-- One row per node in the block tree. step_path ('0/2/1') is the identity;
-- Workato's display `number` is kept for talking to humans but is NOT
-- stable across edits — never join on it.
-- input_json is stored raw and unresolved. UUID->name resolution happens
-- in the tool layer via table_fields, so a manifest fix never requires
-- re-deriving steps.
CREATE TABLE steps (
    snapshot_id  INTEGER NOT NULL,
    recipe_id    TEXT    NOT NULL,
    step_path    TEXT    NOT NULL,
    number       INTEGER,
    depth        INTEGER NOT NULL,
    keyword      TEXT,                           -- action | if | foreach | catch | ...
    provider     TEXT,
    name         TEXT,
    input_json   TEXT,
    PRIMARY KEY (snapshot_id, recipe_id, step_path),
    FOREIGN KEY (snapshot_id, recipe_id) REFERENCES recipes(snapshot_id, recipe_id)
);
CREATE INDEX idx_steps_provider ON steps (snapshot_id, provider);

-- Typed relationships: the edges.json freeze, promoted to rows.
-- src_step_path is NULL for recipe-level dependencies (e.g. trigger
-- connection). `resolved`=0 marks a target not present in this snapshot
-- (external call, deleted table, cross-workspace reference) — keep these
-- visible rather than dropping them; an unresolved edge is itself a fact
-- worth surfacing.
CREATE TABLE edges (
    edge_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_id   INTEGER NOT NULL REFERENCES snapshots(snapshot_id),
    kind          TEXT    NOT NULL
                  CHECK (kind IN ('call_sync', 'call_async', 'table_read',
                                  'table_write', 'connection', 'property')),
    src_recipe_id TEXT    NOT NULL,
    src_step_path TEXT,
    dst_type      TEXT    NOT NULL
                  CHECK (dst_type IN ('recipe', 'table', 'connection', 'property')),
    dst_id        TEXT,
    dst_name      TEXT,
    detail_json   TEXT,                          -- e.g. {"columns": ["<field_key>", ...]}
    resolved      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_edges_dst ON edges (snapshot_id, dst_type, dst_id);
CREATE INDEX idx_edges_dst_name ON edges (snapshot_id, dst_name);
CREATE INDEX idx_edges_src ON edges (snapshot_id, src_recipe_id);

-- Data table manifest. prefix_class is derived from the leading token of
-- the name (CFG, RUN, SUP, WFA, ...) — plain TEXT, no CHECK, so a new
-- prefix convention never breaks the loader.
CREATE TABLE tables (
    snapshot_id  INTEGER NOT NULL REFERENCES snapshots(snapshot_id),
    table_id     TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    prefix_class TEXT,
    PRIMARY KEY (snapshot_id, table_id)
);

-- UUID -> field name resolution as rows, not JSON blobs, because it is
-- joined constantly (get_step resolution, trace_datapill).
-- field_uuid  = canonical hyphenated form from the manifest.
-- field_key   = underscore form, exactly as it appears as an input key in
--               workato_db_table write operations. Storing both means no
--               tool ever does string surgery at query time.
CREATE TABLE table_fields (
    snapshot_id INTEGER NOT NULL,
    table_id    TEXT    NOT NULL,
    field_uuid  TEXT    NOT NULL,
    field_key   TEXT    NOT NULL,
    field_name  TEXT    NOT NULL,
    field_type  TEXT,
    PRIMARY KEY (snapshot_id, table_id, field_uuid),
    FOREIGN KEY (snapshot_id, table_id) REFERENCES tables(snapshot_id, table_id)
);
CREATE INDEX idx_fields_key ON table_fields (snapshot_id, field_key);
CREATE INDEX idx_fields_name ON table_fields (snapshot_id, field_name);

-- Extracted #{_dp('...')} references, one row each, in document order per
-- step (seq). table_id / field_uuid / field_name are filled when the pill
-- resolves to a data-table field; NULL otherwise (pills also reference
-- job context, properties, prior step outputs). This table is what powers
-- "what breaks if I rename this column".
CREATE TABLE datapills (
    snapshot_id INTEGER NOT NULL,
    recipe_id   TEXT    NOT NULL,
    step_path   TEXT    NOT NULL,
    seq         INTEGER NOT NULL,
    provider    TEXT,                            -- source provider from the descriptor
    pill_path   TEXT    NOT NULL,                -- raw path string from the _dp payload
    table_id    TEXT,
    field_uuid  TEXT,
    field_name  TEXT,
    PRIMARY KEY (snapshot_id, recipe_id, step_path, seq),
    FOREIGN KEY (snapshot_id, recipe_id, step_path)
        REFERENCES steps(snapshot_id, recipe_id, step_path)
);
CREATE INDEX idx_pills_field ON datapills (snapshot_id, field_uuid);
CREATE INDEX idx_pills_table ON datapills (snapshot_id, table_id);

-- ---------------------------------------------------------------------------
-- Convenience views — the joins the tool layer runs constantly.
-- ---------------------------------------------------------------------------

CREATE VIEW v_latest_snapshot AS
    SELECT MAX(snapshot_id) AS snapshot_id FROM snapshots;

-- Recipe-to-recipe call graph with names on both ends.
CREATE VIEW v_call_graph AS
    SELECT e.snapshot_id,
           e.kind,
           e.src_recipe_id,
           rs.name AS src_recipe_name,
           e.src_step_path,
           e.dst_id   AS dst_recipe_id,
           COALESCE(rd.name, e.dst_name) AS dst_recipe_name,
           e.resolved
      FROM edges e
      JOIN recipes rs
        ON rs.snapshot_id = e.snapshot_id AND rs.recipe_id = e.src_recipe_id
 LEFT JOIN recipes rd
        ON rd.snapshot_id = e.snapshot_id AND rd.recipe_id = e.dst_id
     WHERE e.kind IN ('call_sync', 'call_async');

-- Who touches which table, and how.
CREATE VIEW v_table_access AS
    SELECT e.snapshot_id,
           e.kind,
           t.name AS table_name,
           t.prefix_class,
           e.src_recipe_id,
           r.name AS recipe_name,
           e.src_step_path,
           e.detail_json
      FROM edges e
      JOIN recipes r
        ON r.snapshot_id = e.snapshot_id AND r.recipe_id = e.src_recipe_id
 LEFT JOIN tables t
        ON t.snapshot_id = e.snapshot_id AND t.table_id = e.dst_id
     WHERE e.dst_type = 'table';
