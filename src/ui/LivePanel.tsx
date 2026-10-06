import { useEffect, useRef, useState } from 'react'
import type { Player, PlayerState } from '../engine/Player'
import {
  activeMerges,
  activeParts,
  explainIndexes,
  listTables,
  matchingGranules,
  runForStats,
  tableMeta,
  type Conn,
  type ExplainStage,
  type MergeInfo,
  type TableInfo,
} from '../model/clickhouse'
import { parseQuery } from '../model/sql'
import { LEVEL_LEGEND, LiveView, type FeedEvent } from '../scenes/live'
import { fmt, fmtBytes } from '../scenes/kit'
import { Bolt, Plug } from './icons'
import { highlightSql } from './sql-highlight'

const STORE = 'granule.conn'
const loadConn = (): Conn => {
  try {
    const c = JSON.parse(localStorage.getItem(STORE) || '{}')
    return { url: c.url || 'http://localhost:8123', user: c.user || 'default', password: '' }
  } catch {
    return { url: 'http://localhost:8123', user: 'default', password: '' }
  }
}

interface QueryResult {
  stages: ExplainStage[]
  rowsRead?: number
  bytesRead?: number
  elapsed?: number
  matchedGranules?: number
  note?: string
}

/** Pull the top-level WHERE clause text out of a query. */
function whereClause(sql: string): string | null {
  const m = /\bWHERE\b([\s\S]*?)(?=\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|\bSETTINGS\b|\bFORMAT\b|\bHAVING\b|$)/i.exec(sql)
  return m ? m[1].trim().replace(/;$/, '') : null
}

export function LivePanel({ player, state }: { player: Player; state: PlayerState | null }) {
  const [conn, setConn] = useState<Conn>(loadConn)
  const [tables, setTables] = useState<TableInfo[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<TableInfo | null>(null)
  const [feed, setFeed] = useState<FeedEvent[]>([])
  const [merges, setMerges] = useState<MergeInfo[]>([])
  const [sql, setSql] = useState('')
  const [result, setResult] = useState<QueryResult | null>(null)
  const viewRef = useRef<LiveView | null>(null)

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const t = await listTables(conn)
      setTables(t)
      try {
        localStorage.setItem(STORE, JSON.stringify({ url: conn.url, user: conn.user }))
      } catch {
        /* storage unavailable */
      }
      if (t.length === 0) setError('Connected, but there are no MergeTree tables outside the system databases.')
    } catch (e) {
      setError((e as Error).message)
      setTables(null)
    } finally {
      setBusy(false)
    }
  }

  const open = async (t: TableInfo) => {
    setBusy(true)
    setError(null)
    setResult(null)
    setFeed([])
    try {
      const [meta, parts] = await Promise.all([tableMeta(conn, t.database, t.name), activeParts(conn, t.database, t.name)])
      const view = new LiveView(t.database, t.name, meta.columns, meta.granularity)
      view.onEvent = (e) => setFeed((f) => [e, ...f].slice(0, 40))
      viewRef.current = view
      player.load(view.scene(parts), { autoplay: true })
      setSelected(t)
      const key = meta.columns.filter((c) => c.is_in_sorting_key).map((c) => c.name)
      setSql(`SELECT count()\nFROM ${t.database}.${t.name}\nWHERE ${key[0] ?? meta.columns[0]?.name ?? '1'} = ${key[0] ? "''" : '1'}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // poll system.parts / system.merges while a table is open
  useEffect(() => {
    if (!selected) return
    let stop = false
    let inFlight = false
    const tick = async () => {
      if (stop || inFlight) return
      inFlight = true
      try {
        const [parts, m] = await Promise.all([activeParts(conn, selected.database, selected.name), activeMerges(conn, selected.database, selected.name)])
        if (stop) return
        setMerges(m)
        await viewRef.current?.update(parts)
      } catch (e) {
        if (!stop) setError((e as Error).message)
      } finally {
        inFlight = false
      }
    }
    const id = setInterval(tick, 1500)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [selected, conn])

  const visualize = async () => {
    const view = viewRef.current
    if (!view || !selected) return
    setBusy(true)
    setError(null)
    try {
      const parsed = parseQuery(sql)
      const cols = new Set(view.shownColumns.map((c) => c.name))
      const readCols = new Set(parsed.idents.filter((i) => cols.has(i)))
      const where = whereClause(sql)
      const [stages, granules, run] = await Promise.all([
        explainIndexes(conn, sql).catch(() => [] as ExplainStage[]),
        matchingGranules(conn, selected.database, selected.name, where, view.granularity).catch(() => null),
        runForStats(conn, sql).catch(() => null),
      ])
      let matches: Map<string, Set<number>> | null = null
      if (granules && where) {
        matches = new Map()
        for (const r of granules) {
          if (!matches.has(r.part)) matches.set(r.part, new Set())
          matches.get(r.part)!.add(Number(r.g))
        }
      }
      view.setHighlight({ readCols, matches })
      setResult({
        stages,
        rowsRead: run?.statistics?.rows_read,
        bytesRead: run?.statistics?.bytes_read,
        elapsed: run?.statistics?.elapsed,
        matchedGranules: granules?.length,
        note: !where ? 'No WHERE clause: every granule of the selected columns is read.' : undefined,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const clear = () => {
    viewRef.current?.setHighlight(null)
    setResult(null)
  }

  return (
    <div className="panel live">
      <h3>
        {selected ? <span className="live-dot" /> : <Plug />} {selected ? `Live · ${selected.database}.${selected.name}` : 'Live cluster'}
      </h3>
      {!tables && (
        <>
          <p className="sub">
            Connect to a ClickHouse server over HTTP to map a real table’s parts and watch inserts and merges as they happen. Credentials stay in this tab.
          </p>
          <div className="field">
            <label>HTTP URL</label>
            <input value={conn.url} onChange={(e) => setConn({ ...conn, url: e.target.value })} />
          </div>
          <div className="grid2">
            <div className="field">
              <label>User</label>
              <input value={conn.user} onChange={(e) => setConn({ ...conn, user: e.target.value })} />
            </div>
            <div className="field">
              <label>Password</label>
              <input type="password" value={conn.password} onChange={(e) => setConn({ ...conn, password: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && connect()} />
            </div>
          </div>
          <div className="row">
            <button className="btn" onClick={connect} disabled={busy}>
              <Plug /> {busy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          <p className="sub" style={{ marginTop: 12 }}>
            No server handy? <code>npm run demo-db</code> starts one in Docker with a seeded <code>demo.events</code> table.
          </p>
        </>
      )}

      {tables && !selected && (
        <>
          <p className="sub">Pick a MergeTree table to map.</p>
          <div className="tables">
            {tables.map((t) => (
              <button key={`${t.database}.${t.name}`} className="table-item" onClick={() => open(t)} disabled={busy}>
                <span>
                  {t.database}.{t.name}
                </span>
                <span>
                  {t.parts} parts · {fmtBytes(Number(t.total_bytes))}
                </span>
              </button>
            ))}
          </div>
          <div className="row">
            <button className="btn ghost" onClick={() => setTables(null)}>
              Disconnect
            </button>
          </div>
        </>
      )}

      {selected && (
        <>
          {state?.stats && (
            <div className="mini-stats">
              {state.stats.map((s) => (
                <div key={s.label} className={`tone-${s.tone ?? 'mist'}`}>
                  <span>{s.label}</span>
                  <b>{s.value}</b>
                </div>
              ))}
            </div>
          )}
          <div className="legend">
            <span>merge level</span>
            {LEVEL_LEGEND.map((l) => (
              <i key={l.level} style={{ background: `rgb(${l.color.map((v) => Math.round(Math.pow(v, 1 / 2.2) * 255)).join(',')})` }} title={`level ${l.level}`}>
                {l.level}
              </i>
            ))}
          </div>
          <div className="editor">
            <pre className="sql" aria-hidden dangerouslySetInnerHTML={{ __html: highlightSql(sql) + '\n' }} />
            <textarea
              value={sql}
              spellCheck={false}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  visualize()
                }
              }}
              aria-label="SQL query"
            />
          </div>
          <div className="row">
            <button className="btn" onClick={visualize} disabled={busy}>
              <Bolt /> {busy ? 'Running…' : 'Visualize'}
            </button>
            {result && (
              <button className="btn ghost" onClick={clear}>
                Clear
              </button>
            )}
            <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={() => setSelected(null)}>
              Tables
            </button>
          </div>
          {result && (
            <div className="explain">
              {result.stages.map((s) => (
                <div key={s.type} className="xstage" title={s.algorithm}>
                  <span>{s.type}</span>
                  <span>
                    parts <b>{s.parts[0]}</b>/{s.parts[1]}
                  </span>
                  <span>
                    granules <b>{s.granules[0]}</b>/{s.granules[1]}
                  </span>
                </div>
              ))}
              {result.rowsRead !== undefined && (
                <div className="xstage total">
                  <span>read</span>
                  <span>
                    <b>{fmt(result.rowsRead)}</b> rows
                  </span>
                  <span>
                    <b>{fmtBytes(result.bytesRead ?? 0)}</b> in {((result.elapsed ?? 0) * 1000).toFixed(0)} ms
                  </span>
                </div>
              )}
              {result.note && <div className="sub">{result.note}</div>}
              {result.matchedGranules !== undefined && <div className="sub">Lit cells: granules that contain matching rows ({fmt(result.matchedGranules)}).</div>}
            </div>
          )}
          {merges.length > 0 && (
            <div className="feed">
              {merges.map((m) => (
                <div key={m.result_part_name} className="mrg">
                  merging → {m.result_part_name} · {Math.round(m.progress * 100)}%
                </div>
              ))}
            </div>
          )}
          <div className="feed">
            {feed.length === 0 && <div className="del">Watching system.parts… insert something to see it land.</div>}
            {feed.map((e, i) => (
              <div key={e.at + '-' + i} className={e.kind === 'insert' ? 'ins' : e.kind === 'merge' ? 'mrg' : 'del'}>
                {new Date(e.at).toLocaleTimeString()} {e.text}
              </div>
            ))}
          </div>
        </>
      )}
      {error && <div className="err">{error}</div>}
    </div>
  )
}
