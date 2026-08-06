-- schema_catalog.sql — the agent's view catalog (D1 resolved: middle path).
--
-- Apply once to an existing database:   sqlite3 facts.db < schema_catalog.sql
-- Or fold into schema.sql so rebuilds carry it. Requires v_latest_snapshot.
--
-- Convention: catalog views are LATEST-SCOPED, so the recommended query path
-- can never point at a fossil snapshot. Base tables (and the snapshot-keyed
-- views v_call_graph / v_table_access) remain available for history and M2
-- diffing.
--
-- Promotion ritual: any join written twice — by you or by the agent — gets a
-- name here. The catalog is the record of which questions turned out to
-- matter.

-- Q1 promoted: who writes which field of which table, columns resolved.
CREATE VIEW IF NOT EXISTS v_field_writes AS
    SELECT r.name            AS recipe_name,
           e.src_recipe_id   AS recipe_id,
           e.src_step_path   AS step_path,
           t.name            AS table_name,
           tf.field_name,
           tf.field_key
      FROM edges e
      JOIN v_latest_snapshot ls ON ls.snapshot_id = e.snapshot_id
      JOIN recipes r  ON r.snapshot_id = e.snapshot_id
                     AND r.recipe_id  = e.src_recipe_id
      JOIN tables t   ON t.snapshot_id = e.snapshot_id
                     AND t.table_id   = e.dst_id
      JOIN json_each(e.detail_json, '$.columns') c
      JOIN table_fields tf ON tf.snapshot_id = e.snapshot_id
                          AND tf.table_id   = e.dst_id
                          AND tf.field_key  = c.value
     WHERE e.kind = 'table_write';

-- Q2 promoted: every consumer of a resolved data-table field.
-- (Unresolved pills stay queryable in the datapills base table.)
CREATE VIEW IF NOT EXISTS v_datapill_consumers AS
    SELECT r.name       AS recipe_name,
           d.recipe_id,
           d.step_path,
           s.provider   AS step_provider,
           t.name       AS table_name,
           d.field_name,
           d.pill_path
      FROM datapills d
      JOIN v_latest_snapshot ls ON ls.snapshot_id = d.snapshot_id
      JOIN recipes r ON r.snapshot_id = d.snapshot_id
                    AND r.recipe_id  = d.recipe_id
 LEFT JOIN steps s   ON s.snapshot_id = d.snapshot_id
                    AND s.recipe_id  = d.recipe_id
                    AND s.step_path  = d.step_path
 LEFT JOIN tables t  ON t.snapshot_id = d.snapshot_id
                    AND t.table_id   = d.table_id
     WHERE d.field_name IS NOT NULL;

-- Q3's edge set: the call graph, latest snapshot only. Traversal itself is
-- query-authored (see the recursive-CTE pattern in corpus.py's docstring) —
-- that flexibility is the point of the middle path.
CREATE VIEW IF NOT EXISTS v_calls AS
    SELECT g.kind,
           g.src_recipe_id,
           g.src_recipe_name,
           g.src_step_path,
           g.dst_recipe_id,
           g.dst_recipe_name,
           g.resolved          -- 0 = target not in this snapshot: a finding
      FROM v_call_graph g
      JOIN v_latest_snapshot ls ON ls.snapshot_id = g.snapshot_id;

-- Latest table-access projection, same convention.
CREATE VIEW IF NOT EXISTS v_table_use AS
    SELECT a.kind,
           a.table_name,
           a.prefix_class,
           a.src_recipe_id AS recipe_id,
           a.recipe_name,
           a.src_step_path AS step_path
      FROM v_table_access a
      JOIN v_latest_snapshot ls ON ls.snapshot_id = a.snapshot_id;
