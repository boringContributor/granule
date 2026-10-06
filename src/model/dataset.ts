/**
 * The table behind the Query lab. Real ClickHouse keeps exactly this kind of metadata:
 * per-part min/max of the partition key (minmax index) and, via the primary index marks,
 * the key range of every granule. The data itself is never simulated — only its shape.
 */

export type ColKind = 'date' | 'enum' | 'num' | 'str'

export interface ColumnDef {
  name: string
  type: string
  kind: ColKind
  /** compressed bytes per granule, used to estimate bytes read */
  bytes: number
  /** approximate number of distinct values */
  distinct: number
  /** sorted dictionary for LowCardinality(String) columns */
  dict?: string[]
}

export interface GranuleMeta {
  rows: number
  /** min/max per column, encoded as numbers (dates in days, enums as dictionary index) */
  r: Record<string, [number, number]>
}

export interface PartMeta {
  name: string
  partition: string
  level: number
  rows: number
  granules: GranuleMeta[]
  /** minmax index over the partition-key columns */
  minmax: Record<string, [number, number]>
}

export interface ShardMeta {
  name: string
  parts: PartMeta[]
}

export interface Dataset {
  table: string
  distributed: string | null
  columns: ColumnDef[]
  orderBy: string[]
  partitionBy: string
  /** columns covered by the minmax index (those inside the partition expression) */
  partitionColumns: string[]
  shards: ShardMeta[]
  /** what today() means, in days since epoch */
  today: number
  granularity: number
}

export const dayOf = (iso: string) => Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000)
export const isoOf = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10)

const EVENT_TYPES = ['click', 'pageview', 'purchase', 'signup']
const TYPE_SHARE = [0.3, 0.5, 0.08, 0.12]
const COUNTRIES = ['AU', 'BR', 'CA', 'DE', 'ES', 'FR', 'GB', 'IN', 'JP', 'NL', 'SE', 'US']
const MONTHS = ['2024-07', '2024-08', '2024-09', '2024-10']

function rngFrom(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

export function demoDataset(): Dataset {
  const rand = rngFrom(99)
  const G = 8192
  const columns: ColumnDef[] = [
    { name: 'event_date', type: 'Date', kind: 'date', bytes: 1300, distinct: 123 },
    { name: 'event_type', type: 'LowCardinality(String)', kind: 'enum', bytes: 900, distinct: 4, dict: EVENT_TYPES },
    { name: 'user_id', type: 'UInt64', kind: 'num', bytes: 38000, distinct: 1_200_000 },
    { name: 'country', type: 'LowCardinality(String)', kind: 'enum', bytes: 4200, distinct: 12, dict: COUNTRIES },
    { name: 'url', type: 'String', kind: 'str', bytes: 210000, distinct: 48_000 },
    { name: 'duration_ms', type: 'UInt32', kind: 'num', bytes: 16000, distinct: 60_000 },
    { name: 'revenue', type: 'Decimal(10, 2)', kind: 'num', bytes: 6500, distinct: 9_000 },
  ]

  const cum = [0]
  for (const s of TYPE_SHARE) cum.push(cum[cum.length - 1] + s)
  const segOf = (f: number) => {
    for (let i = 0; i < TYPE_SHARE.length; i++) if (f < cum[i + 1] - 1e-9) return i
    return TYPE_SHARE.length - 1
  }

  /** Granules of a part sorted by (event_type, event_date) covering [d0, d1]. */
  const makeGranules = (count: number, d0: number, d1: number): GranuleMeta[] =>
    Array.from({ length: count }, (_, i) => {
      const f0 = i / count
      const f1 = (i + 1) / count
      const t0 = segOf(f0)
      const t1 = segOf(f1 - 1e-6)
      let date: [number, number]
      if (t0 === t1) {
        const a = cum[t0]
        const b = cum[t0 + 1]
        date = [Math.floor(d0 + ((f0 - a) / (b - a)) * (d1 - d0)), Math.ceil(d0 + ((f1 - a) / (b - a)) * (d1 - d0))]
      } else date = [d0, d1]
      const spend = t1 >= 2
      return {
        rows: G,
        r: {
          event_date: date,
          event_type: [t0, t1],
          user_id: [Math.floor(rand() * 4000) + 1, 1_200_000 - Math.floor(rand() * 4000)],
          country: [0, COUNTRIES.length - 1],
          duration_ms: [Math.floor(rand() * 20), 60000 - Math.floor(rand() * 900)],
          revenue: spend ? [0, 480 + Math.floor(rand() * 20)] : [0, 0],
        },
      }
    })

  let block = 0
  const shards: ShardMeta[] = [1, 2, 3].map((n) => ({
    name: `shard ${n}`,
    parts: MONTHS.flatMap((m) => {
      const pid = m.replace('-', '')
      const start = dayOf(`${m}-01`)
      const next = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1))
      const end = Math.floor(next.getTime() / 86400000) - 1
      const split = Math.floor(start + (end - start) * 0.8)
      const a = ++block
      const b = (block += 11)
      const c = ++block
      const big = makeGranules(6, start, split)
      const small = makeGranules(2, split + 1, end)
      return [
        { name: `${pid}_${a}_${b}_2`, partition: pid, level: 2, rows: big.length * G, granules: big, minmax: { event_date: [start, split] as [number, number] } },
        { name: `${pid}_${c}_${c}_0`, partition: pid, level: 0, rows: small.length * G, granules: small, minmax: { event_date: [split + 1, end] as [number, number] } },
      ]
    }),
  }))

  return {
    table: 'events',
    distributed: 'events',
    columns,
    orderBy: ['event_type', 'event_date'],
    partitionBy: 'toYYYYMM(event_date)',
    partitionColumns: ['event_date'],
    shards,
    today: dayOf('2024-10-31'),
    granularity: G,
  }
}

export const DEMO_DDL = `CREATE TABLE events_local ON CLUSTER demo (
  event_date  Date,
  event_type  LowCardinality(String),
  user_id     UInt64,
  country     LowCardinality(String),
  url         String,
  duration_ms UInt32,
  revenue     Decimal(10, 2)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(event_date)
ORDER BY (event_type, event_date);

CREATE TABLE events AS events_local
ENGINE = Distributed(demo, default, events_local, rand());`
