/**
 * Minimal ClickHouse HTTP client for the browser.
 *
 * Requests are sent as "simple" CORS requests (POST, text/plain body, credentials in the
 * query string) so no preflight is needed; `add_http_cors_header=1` makes the server answer
 * with `Access-Control-Allow-Origin: *`. Credentials stay in memory only.
 */

export interface Conn {
  url: string
  user: string
  password: string
}

export interface JsonResult<T> {
  data: T[]
  rows: number
  statistics?: { elapsed: number; rows_read: number; bytes_read: number }
}

export class ClickHouseError extends Error {}

export async function chQuery<T = Record<string, unknown>>(conn: Conn, sql: string, settings: Record<string, string | number> = {}): Promise<JsonResult<T>> {
  const u = new URL(conn.url.replace(/\/+$/, '') + '/')
  u.searchParams.set('add_http_cors_header', '1')
  u.searchParams.set('default_format', 'JSON')
  u.searchParams.set('output_format_json_quote_64bit_integers', '0')
  if (conn.user) u.searchParams.set('user', conn.user)
  if (conn.password) u.searchParams.set('password', conn.password)
  for (const [k, v] of Object.entries(settings)) u.searchParams.set(k, String(v))
  let res: Response
  try {
    res = await fetch(u.toString(), { method: 'POST', body: sql, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })
  } catch {
    throw new ClickHouseError(`Can't reach ${conn.url}. Is the server running and reachable from this browser? (CORS needs add_http_cors_header, which granule sets.)`)
  }
  const text = await res.text()
  if (!res.ok) throw new ClickHouseError(text.trim().split('\n')[0].slice(0, 400) || `HTTP ${res.status}`)
  try {
    return JSON.parse(text) as JsonResult<T>
  } catch {
    // EXPLAIN and friends may come back as plain text
    return { data: text.split('\n').filter(Boolean).map((l) => ({ explain: l }) as T), rows: 0 }
  }
}

export const quoteIdent = (s: string) => '`' + s.replace(/`/g, '\\`') + '`'
export const quoteStr = (s: string) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"

export interface TableInfo {
  database: string
  name: string
  engine: string
  total_rows: number
  total_bytes: number
  parts: number
}

export interface ColumnInfo {
  name: string
  type: string
  data_compressed_bytes: number
  is_in_sorting_key: number
  is_in_partition_key: number
}

export interface PartInfo {
  name: string
  partition_id: string
  partition: string
  rows: number
  marks: number
  level: number
  bytes_on_disk: number
  min_block_number: number
  max_block_number: number
}

export interface MergeInfo {
  result_part_name: string
  source_part_names: string[]
  progress: number
  elapsed: number
}

export async function listTables(conn: Conn) {
  const r = await chQuery<TableInfo>(
    conn,
    `SELECT t.database AS database, t.name AS name, t.engine AS engine,
            toUInt64(ifNull(t.total_rows, 0)) AS total_rows, toUInt64(ifNull(t.total_bytes, 0)) AS total_bytes,
            toUInt64(countIf(p.active)) AS parts
     FROM system.tables AS t
     LEFT JOIN system.parts AS p ON p.database = t.database AND p.table = t.name
     WHERE t.engine LIKE '%MergeTree%' AND t.database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
     GROUP BY t.database, t.name, t.engine, t.total_rows, t.total_bytes
     ORDER BY total_bytes DESC, t.database, t.name
     LIMIT 200`,
  )
  return r.data
}

export async function tableMeta(conn: Conn, db: string, table: string) {
  const [cols, info] = await Promise.all([
    chQuery<ColumnInfo>(
      conn,
      `SELECT name, type, data_compressed_bytes, is_in_sorting_key, is_in_partition_key
       FROM system.columns WHERE database = ${quoteStr(db)} AND table = ${quoteStr(table)} ORDER BY position`,
    ),
    chQuery<{ sorting_key: string; partition_key: string; engine: string }>(
      conn,
      `SELECT sorting_key, partition_key, engine FROM system.tables WHERE database = ${quoteStr(db)} AND name = ${quoteStr(table)}`,
    ),
  ])
  let granularity = 8192
  try {
    const g = await chQuery<{ v: string }>(
      conn,
      `SELECT extract(create_table_query, 'index_granularity\\\\s*=\\\\s*(\\\\d+)') AS v FROM system.tables WHERE database = ${quoteStr(db)} AND name = ${quoteStr(table)}`,
    )
    if (g.data[0]?.v) granularity = parseInt(g.data[0].v, 10)
  } catch {
    /* keep the default */
  }
  return { columns: cols.data, info: info.data[0], granularity }
}

export async function activeParts(conn: Conn, db: string, table: string) {
  const r = await chQuery<PartInfo>(
    conn,
    `SELECT name, partition_id, partition, rows, marks, level, bytes_on_disk, min_block_number, max_block_number
     FROM system.parts WHERE database = ${quoteStr(db)} AND table = ${quoteStr(table)} AND active
     ORDER BY partition_id, min_block_number`,
  )
  return r.data
}

export async function activeMerges(conn: Conn, db: string, table: string) {
  const r = await chQuery<MergeInfo>(
    conn,
    `SELECT result_part_name, source_part_names, progress, elapsed FROM system.merges
     WHERE database = ${quoteStr(db)} AND table = ${quoteStr(table)}`,
  )
  return r.data
}

export interface ExplainStage {
  type: string
  parts: [number, number]
  granules: [number, number]
  algorithm?: string
}

/**
 * Parse `EXPLAIN indexes = 1` text into its index stages (MinMax, Partition, PrimaryKey, Skip…).
 * Handles both the older `Type: MinMax` layout and the newer bare `Min-Max` headings.
 */
export function parseExplainIndexes(lines: string[]): ExplainStage[] {
  const out: ExplainStage[] = []
  let cur: Partial<ExplainStage> | null = null
  const flush = () => {
    if (cur?.type && cur.parts && cur.granules) out.push(cur as ExplainStage)
    cur = null
  }
  for (const raw of lines) {
    const l = raw.replace(/^[\s│└├─]+/, '').trim()
    const t = /^Type:\s*(\w+)/.exec(l) ?? /^(Min-?Max|Partition|PrimaryKey|Skip)$/.exec(l)
    if (t) {
      flush()
      cur = { type: t[1].replace('-', '') }
      continue
    }
    if (!cur) continue
    const name = /^Name:\s*(.+)/.exec(l)
    if (name && cur.type === 'Skip') cur.type = `Skip ${name[1]}`
    const p = /^Parts:\s*(\d+)\/(\d+)/.exec(l)
    if (p) cur.parts = [+p[1], +p[2]]
    const g = /^Granules:\s*(\d+)\/(\d+)/.exec(l)
    if (g) cur.granules = [+g[1], +g[2]]
    const a = /^Search Algorithm:\s*(.+)/.exec(l)
    if (a) cur.algorithm = a[1]
  }
  flush()
  return out
}

export async function explainIndexes(conn: Conn, sql: string) {
  const r = await chQuery<{ explain: string }>(conn, `EXPLAIN indexes = 1 ${sql.replace(/;\s*$/, '')}`, { default_format: 'JSON' })
  return parseExplainIndexes(r.data.map((d) => d.explain))
}

/** Which granules of which parts contain rows matching a WHERE clause. */
export async function matchingGranules(conn: Conn, db: string, table: string, where: string | null, granularity: number) {
  const r = await chQuery<{ part: string; g: number; c: number }>(
    conn,
    `SELECT _part AS part, intDiv(_part_offset, ${granularity}) AS g, count() AS c
     FROM ${quoteIdent(db)}.${quoteIdent(table)}
     ${where ? `WHERE ${where}` : ''}
     GROUP BY part, g LIMIT 100000`,
    { max_execution_time: 15 },
  )
  return r.data
}

/** Run the query itself, discarding the result, to read the real rows_read / bytes_read. */
export async function runForStats(conn: Conn, sql: string) {
  const r = await chQuery(conn, sql.replace(/;\s*$/, ''), { max_execution_time: 20, max_result_rows: 1000, result_overflow_mode: 'break' })
  return { rows: r.rows, statistics: r.statistics }
}
