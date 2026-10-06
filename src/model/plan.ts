import { dayOf, type ColumnDef, type Dataset, type GranuleMeta, type PartMeta } from './dataset'
import { hasAggregate, parseQuery, type Expr, type Query } from './sql'

export type Range = [number, number]
type Env = (col: string) => Range | undefined

export interface Plan {
  sql: string
  query: Query
  readCols: string[]
  star: boolean
  trivialCount: boolean
  aggregate: boolean
  groupBy: string[]
  /** LIMIT without ORDER BY / aggregation: reading stops after the first blocks */
  earlyStop: boolean
  partKept: Map<PartMeta, boolean>
  granKept: Map<GranuleMeta, boolean>
  usesPartition: boolean
  keyColsUsed: string[]
  nonKeyFilterCols: string[]
  warnings: string[]
  totals: {
    parts: number
    partsKept: number
    partitions: number
    partitionsKept: number
    granules: number
    granulesAfterPartition: number
    granulesKept: number
    rows: number
    rowsRead: number
    bytes: number
    bytesRead: number
  }
  resultRows: number | null
}

const MONOTONIC: Record<string, (v: number, col: ColumnDef) => number> = {
  todate: (v) => v,
  todatetime: (v) => v,
  tostartofday: (v) => v,
  toyyyymm: (v) => {
    const d = new Date(v * 86400000)
    return d.getUTCFullYear() * 100 + d.getUTCMonth() + 1
  },
  toyyyymmdd: (v) => {
    const d = new Date(v * 86400000)
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
  },
  tostartofmonth: (v) => {
    const d = new Date(v * 86400000)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86400000
  },
  tostartofweek: (v) => v - ((new Date(v * 86400000).getUTCDay() + 7) % 7),
  toyear: (v) => new Date(v * 86400000).getUTCFullYear(),
}

const INTERVAL_DAYS: Record<string, number> = { DAY: 1, DAYS: 1, WEEK: 7, WEEKS: 7, MONTH: 30, MONTHS: 30, QUARTER: 91, YEAR: 365, YEARS: 365, HOUR: 1 / 24, MINUTE: 1 / 1440, SECOND: 1 / 86400 }

/** Encode a literal in the column's numeric space. */
function encode(v: Expr, col: ColumnDef | undefined): number | undefined {
  if (v.k === 'num') return v.v
  if (v.k === 'str') {
    if (!col) return undefined
    if (col.kind === 'date') return /^\d{4}-\d{2}-\d{2}/.test(v.v) ? dayOf(v.v) : undefined
    if (col.kind === 'enum' && col.dict) {
      const i = col.dict.indexOf(v.v)
      if (i >= 0) return i
      // not in the dictionary: place it between neighbours so range checks still work
      let j = 0
      while (j < col.dict.length && col.dict[j] < v.v) j++
      return j - 0.5
    }
    if (col.kind === 'num') {
      const n = Number(v.v)
      return Number.isFinite(n) ? n : undefined
    }
    return undefined
  }
  return undefined
}

export function planQuery(sql: string, ds: Dataset): Plan {
  const query = parseQuery(sql)
  const colByName = new Map(ds.columns.map((c) => [c.name, c]))
  const warnings: string[] = []

  const known = ds.columns.map((c) => c.name)
  const aliases = new Set(query.aliases)
  const unknown = [...new Set(query.idents.filter((i) => !colByName.has(i) && !aliases.has(i)))]
  if (unknown.length) warnings.push(`Unknown column${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `<code>${u}</code>`).join(', ')}, ignored. The demo table has ${known.map((k) => `<code>${k}</code>`).join(' ')}.`)
  const fromOk = [ds.table, ds.distributed, `${ds.table}_local`, `${ds.table}_dist`].includes(query.from)
  if (!fromOk) warnings.push(`The lab runs every query against its demo table <code>${ds.table}</code>.`)

  const star = query.select.some((e) => e.k === 'star')
  const used = new Set(query.idents.filter((i) => colByName.has(i)))
  let readCols = star ? known.slice() : known.filter((c) => used.has(c))

  const aggregate = query.groupBy.length > 0 || query.select.some(hasAggregate)
  const where = combine(query.where, query.prewhere)
  const trivialCount = !where && query.groupBy.length === 0 && query.select.length === 1 && isPlainCount(query.select[0])
  if (!trivialCount && readCols.length === 0) {
    // count() with a filter-free GROUP BY etc. still needs one column: ClickHouse picks the smallest
    const smallest = ds.columns.slice().sort((a, b) => a.bytes - b.bytes)[0]
    readCols = [smallest.name]
  }

  const groupBy = query.groupBy.flatMap((e) => (e.k === 'col' ? [e.name] : e.k === 'fn' ? e.args.filter((a) => a.k === 'col').map((a: any) => a.name) : []))
  const earlyStop = !aggregate && query.limit !== null && query.orderBy.length === 0 && !trivialCount

  // ---- evaluation helpers ----
  const colOf = (e: Expr): ColumnDef | undefined => {
    if (e.k === 'col') return colByName.get(e.name)
    if (e.k === 'fn' && e.args.length >= 1) return colOf(e.args[0])
    if (e.k === 'bin') return colOf(e.l) ?? colOf(e.r)
    return undefined
  }

  /** Range of an expression given column ranges; undefined = unknown. */
  const range = (e: Expr, env: Env, hint?: ColumnDef): Range | undefined => {
    switch (e.k) {
      case 'col': {
        if (!colByName.has(e.name)) return undefined
        return env(e.name)
      }
      case 'num':
      case 'str': {
        const v = encode(e, hint)
        return v === undefined ? undefined : [v, v]
      }
      case 'interval': {
        const r = range(e.v, env)
        const k = INTERVAL_DAYS[e.unit] ?? 1
        return r ? [r[0] * k, r[1] * k] : undefined
      }
      case 'fn': {
        const name = e.name.toLowerCase()
        if (name === 'today' || name === 'now') return [ds.today, ds.today]
        if (name === 'yesterday') return [ds.today - 1, ds.today - 1]
        const arg = e.args[0]
        if (!arg) return undefined
        if ((name === 'todate' || name === 'todatetime') && arg.k === 'str') {
          const v = encode(arg, { name: '', type: 'Date', kind: 'date', bytes: 0, distinct: 0 })
          return v === undefined ? undefined : [v, v]
        }
        const f = MONOTONIC[name]
        const inner = range(arg, env, hint)
        if (!f || !inner) return undefined
        const c = colOf(arg)
        if (!c) return undefined
        return [f(inner[0], c), f(inner[1], c)]
      }
      case 'bin': {
        if (!['+', '-'].includes(e.op)) return undefined
        const a = range(e.l, env, hint)
        const b = range(e.r, env, hint)
        if (!a || !b) return undefined
        return e.op === '+' ? [a[0] + b[0], a[1] + b[1]] : [a[0] - b[1], a[1] - b[0]]
      }
      default:
        return undefined
    }
  }

  /** May any row with these column ranges satisfy e? Conservative: unknown → true. */
  const may = (e: Expr, env: Env): boolean => {
    switch (e.k) {
      case 'and':
        return e.items.every((x) => may(x, env))
      case 'or':
        return e.items.some((x) => may(x, env))
      case 'not': {
        const x = e.e
        if (x.k === 'bin') {
          const inv: Record<string, string> = { '=': '!=', '!=': '=', '<': '>=', '<=': '>', '>': '<=', '>=': '<' }
          return inv[x.op] ? may({ ...x, op: inv[x.op] }, env) : true
        }
        return true
      }
      case 'bin': {
        if (!['=', '!=', '<', '<=', '>', '>='].includes(e.op)) return true
        const hl = colOf(e.l)
        const hr = colOf(e.r)
        const L = range(e.l, env, hr)
        const R = range(e.r, env, hl)
        if (!L || !R) return true
        switch (e.op) {
          case '=':
            return L[0] <= R[1] && R[0] <= L[1]
          case '!=':
            return !(L[0] === L[1] && R[0] === R[1] && L[0] === R[0])
          case '<':
            return L[0] < R[1]
          case '<=':
            return L[0] <= R[1]
          case '>':
            return L[1] > R[0]
          case '>=':
            return L[1] >= R[0]
        }
        return true
      }
      case 'in': {
        if (e.neg) return true
        return e.list.some((v) => may({ k: 'bin', op: '=', l: e.e, r: v }, env))
      }
      case 'between': {
        if (e.neg) return true
        return may({ k: 'and', items: [{ k: 'bin', op: '>=', l: e.e, r: e.lo }, { k: 'bin', op: '<=', l: e.e, r: e.hi }] }, env)
      }
      default:
        return true
    }
  }

  // ---- which columns does the filter constrain? ----
  const filterCols = new Set<string>()
  const walk = (e: Expr | null) => {
    if (!e) return
    if (e.k === 'col') filterCols.add(e.name)
    else if (e.k === 'fn') e.args.forEach(walk)
    else if (e.k === 'bin') (walk(e.l), walk(e.r))
    else if (e.k === 'and' || e.k === 'or') e.items.forEach(walk)
    else if (e.k === 'not') walk(e.e)
    else if (e.k === 'in') (walk(e.e), e.list.forEach(walk))
    else if (e.k === 'between') (walk(e.e), walk(e.lo), walk(e.hi))
    else if (e.k === 'like') walk(e.e)
  }
  walk(where)
  const usesPartition = ds.partitionColumns.some((c) => filterCols.has(c))
  const keyColsUsed = ds.orderBy.filter((c) => filterCols.has(c))
  const nonKeyFilterCols = [...filterCols].filter((c) => colByName.has(c) && !ds.orderBy.includes(c))

  // ---- prune ----
  const partKept = new Map<PartMeta, boolean>()
  const granKept = new Map<GranuleMeta, boolean>()
  const allParts = ds.shards.flatMap((s) => s.parts)
  for (const part of allParts) {
    const keep = trivialCount ? false : !where || may(where, (c) => (ds.partitionColumns.includes(c) ? part.minmax[c] : undefined))
    partKept.set(part, keep)
    for (const g of part.granules) {
      const k = keep && (!where || may(where, (c) => (ds.orderBy.includes(c) ? g.r[c] : undefined)))
      granKept.set(g, k)
    }
  }
  if (earlyStop) {
    // the first block per shard is enough to satisfy a small LIMIT
    for (const s of ds.shards) {
      let left = Math.max(1, Math.ceil((query.limit ?? 1) / ds.granularity))
      for (const part of s.parts)
        for (const g of part.granules) {
          if (!granKept.get(g)) continue
          if (left > 0) left--
          else granKept.set(g, false)
        }
    }
  }

  const granules = allParts.reduce((s, p) => s + p.granules.length, 0)
  const keptGranules = [...granKept.entries()].filter(([, v]) => v).map(([g]) => g)
  const bytesPerGranule = ds.columns.reduce((s, c) => s + c.bytes, 0)
  const readBytesPerGranule = ds.columns.filter((c) => readCols.includes(c.name)).reduce((s, c) => s + c.bytes, 0)
  const partitions = new Set(allParts.map((p) => p.partition))
  const partitionsKept = new Set(allParts.filter((p) => partKept.get(p)).map((p) => p.partition))

  const totals = {
    parts: allParts.length,
    partsKept: allParts.filter((p) => partKept.get(p)).length,
    partitions: partitions.size,
    partitionsKept: partitionsKept.size,
    granules,
    granulesAfterPartition: allParts.filter((p) => partKept.get(p)).reduce((s, p) => s + p.granules.length, 0),
    granulesKept: keptGranules.length,
    rows: allParts.reduce((s, p) => s + p.rows, 0),
    rowsRead: keptGranules.reduce((s, g) => s + g.rows, 0),
    bytes: granules * bytesPerGranule,
    bytesRead: keptGranules.length * readBytesPerGranule,
  }

  let resultRows: number | null = null
  if (trivialCount) resultRows = 1
  else if (aggregate && groupBy.length === 0) resultRows = 1
  else if (aggregate) {
    const groups = groupBy.reduce((s, c) => s * Math.min(colByName.get(c)?.distinct ?? 100, eqCount(where, c) ?? Infinity), 1)
    resultRows = Math.min(groups, totals.rowsRead)
  }
  if (query.limit !== null) resultRows = Math.min(resultRows ?? query.limit, query.limit)

  return { sql, query, readCols, star, trivialCount, aggregate, groupBy, earlyStop, partKept, granKept, usesPartition, keyColsUsed, nonKeyFilterCols, warnings, totals, resultRows }
}

function combine(a: Expr | null, b: Expr | null): Expr | null {
  if (a && b) return { k: 'and', items: [a, b] }
  return a ?? b
}

function isPlainCount(e: Expr) {
  return e.k === 'fn' && e.name.toLowerCase() === 'count' && (e.args.length === 0 || e.args[0].k === 'star' || e.args[0].k === 'num')
}

/** If the filter pins a column to a fixed set of values, how many? */
function eqCount(e: Expr | null, col: string): number | undefined {
  if (!e) return undefined
  if (e.k === 'and') {
    for (const x of e.items) {
      const n = eqCount(x, col)
      if (n !== undefined) return n
    }
    return undefined
  }
  if (e.k === 'bin' && e.op === '=' && ((e.l.k === 'col' && e.l.name === col) || (e.r.k === 'col' && e.r.name === col))) return 1
  if (e.k === 'in' && !e.neg && e.e.k === 'col' && e.e.name === col) return e.list.length
  return undefined
}
