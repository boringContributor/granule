import type { Cell } from '../engine/Cells'
import { COLUMN_HUES, P, mix, scale } from '../engine/palette'
import { demoDataset, type Dataset, type GranuleMeta, type PartMeta } from '../model/dataset'
import { planQuery, type Plan } from '../model/plan'
import { all, center, drop, fade, fit, fitRig, fmt, fmtBytes, packet, setCamera, spawn, stream, tint, type V3 } from './kit'
import type { Ctx, SceneDef, Stat, Step } from './types'

export const DEFAULT_SQL = `SELECT country, count() AS orders
FROM events
WHERE event_type = 'purchase'
  AND event_date >= '2024-09-01'
GROUP BY country`

export const PRESETS: { label: string; sql: string }[] = [
  { label: 'Purchases since September', sql: DEFAULT_SQL },
  { label: 'Trivial count', sql: 'SELECT count() FROM events' },
  { label: 'One week of pageviews', sql: "SELECT avg(duration_ms)\nFROM events\nWHERE event_type = 'pageview'\n  AND event_date BETWEEN today() - 7 AND today()" },
  { label: 'SELECT * by user', sql: 'SELECT *\nFROM events\nWHERE user_id = 42' },
  { label: 'LIMIT stops early', sql: 'SELECT url FROM events LIMIT 10' },
  { label: 'One month', sql: "SELECT event_type, sum(revenue)\nFROM events\nWHERE toYYYYMM(event_date) = 202409\nGROUP BY event_type" },
]

const SX = 4.4
const CPX = 0.42
const GP = 0.24
const PART_GAP = 0.14
const PARTITION_GAP = 0.55

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0)

interface GCell {
  cell: Cell
  shard: number
  part: PartMeta
  g: GranuleMeta
  col: string
}

export function makeQueryLab(sql: string, ds: Dataset = demoDataset()): SceneDef {
  return {
    id: 'lab',
    title: 'Query lab',
    kicker: 'Paste SQL, watch it execute',
    blurb: '',
    create(ctx) {
      let plan: Plan
      try {
        plan = planQuery(sql, ds)
      } catch (e) {
        return errorScene(ctx, (e as Error).message)
      }
      return buildLab(ctx, ds, plan)
    },
  }
}

function errorScene(ctx: Ctx, message: string) {
  return {
    steps: [
      {
        title: 'The lab couldn’t read this query',
        body: `${message}. The lab understands <code>SELECT … FROM … WHERE … GROUP BY … ORDER BY … LIMIT</code>.`,
        hold: 100000,
        async run() {
          ctx.stats(null)
        },
      },
    ],
  }
}

function buildLab(ctx: Ctx, ds: Dataset, plan: Plan) {
  const { world, tw } = ctx
  const cols = ds.columns.map((c) => c.name)
  const nCols = cols.length

  // ---------- layout ----------
  const partitions = [...new Set(ds.shards[0].parts.map((p) => p.partition))]
  const zOf = new Map<PartMeta, number>()
  const partitionZ = new Map<string, [number, number]>()
  let z = 0
  for (const pid of partitions) {
    const z0 = z
    for (const part of ds.shards[0].parts.filter((p) => p.partition === pid)) {
      zOf.set(part, z)
      z += part.granules.length * GP + PART_GAP
    }
    partitionZ.set(pid, [z0, z - PART_GAP])
    z += PARTITION_GAP
  }
  const depth = z - PARTITION_GAP
  const zShift = -depth / 2
  const front = depth / 2
  const shardX = ds.shards.map((_, i) => (i - (ds.shards.length - 1) / 2) * SX)
  const nodeZ = front + 1.3
  const initAt: V3 = [0, 0, front + 3.4]

  const gcells: GCell[] = []
  ds.shards.forEach((shard, si) =>
    shard.parts.forEach((part, pi) => {
      const p0 = zOf.get(ds.shards[0].parts[pi]) ?? 0
      part.granules.forEach((g, gi) =>
        cols.forEach((col, ci) => {
          const hue = COLUMN_HUES[ci % COLUMN_HUES.length]
          const cell = spawn(ctx, {
            x: shardX[si] + (ci - (nCols - 1) / 2) * CPX,
            z: zShift + p0 + gi * GP + GP / 2,
            w: 0.34,
            d: 0.18,
            h: 0.14,
            color: scale(hue, part.level === 0 ? 0.62 : 0.8),
            data: { si, ci },
          })
          gcells.push({ cell, shard: si, part, g, col })
        }),
      )
    }),
  )
  const cellsOf = (pred: (g: GCell) => boolean) => gcells.filter(pred).map((g) => g.cell)

  const shardLabels = ds.shards.map((s, i) => world.label(`<span class="k">${s.name.split(' ')[0]}</span>${s.name.split(' ')[1] ?? ''}`, shardX[i], 0.02, front + 0.5, 'tag', 0))
  const colLabels = cols.map((c, ci) => world.label(`<span>${c}</span>`, shardX[0] + (ci - (nCols - 1) / 2) * CPX - 0.05, 0.02, zShift - 0.25, 'col', 0))
  const partitionLabels = partitions.map((pid) => {
    const [a, b] = partitionZ.get(pid)!
    return world.label(pid, shardX[0] - (nCols * CPX) / 2 - 0.85, 0.02, zShift + (a + b) / 2, 'small', 0)
  })
  const partOutlines = new Map<PartMeta, ReturnType<typeof world.rect>>()
  ds.shards.forEach((shard, si) =>
    shard.parts.forEach((part, pi) => {
      const p0 = zOf.get(ds.shards[0].parts[pi]) ?? 0
      const d = part.granules.length * GP
      partOutlines.set(part, world.rect(shardX[si], 0.006, zShift + p0 + d / 2, nCols * CPX + 0.08, d + 0.05, P.steel, 0))
    }),
  )

  const initBox = ctx.cells.alloc({ x: initAt[0], y: 0, z: initAt[2], w: 2, h: 0.32, d: 0.7, a: 0, color: P.slate })
  const initLabel = world.label('<span class="k">initiator</span>client ⇄', initAt[0] + 1.75, 0.02, initAt[2], 'tag volt', 0)
  const nodes = shardX.map((x) => ctx.cells.alloc({ x, y: 0, z: nodeZ, w: 1.2, h: 0.12, d: 0.45, a: 0, color: P.slate }))
  const arcs = shardX.map((x) => world.arc([initAt[0], 0.4, initAt[2] - 0.35], [x, 0.2, nodeZ + 0.1], 1.6, P.mist, 0, true))
  const resultLabel = world.label('', initAt[0], 1.5, initAt[2], 'tag volt', 0)

  const T = plan.totals
  const readSet = new Set(plan.readCols)
  const keptPart = (p: PartMeta) => plan.partKept.get(p)!
  const keptGranule = (g: GranuleMeta) => plan.granKept.get(g)!

  const FULL = { x0: shardX[0] - 3, x1: shardX[shardX.length - 1] + 2.2, z0: zShift - 0.9, z1: initAt[2] + 0.6 }
  setCamera(ctx, fitRig(ctx, FULL, { theta: -0.08, phi: 0.92, pad: 1.0, usable: 0.5 }))

  const baseStats = (): Stat[] => [
    { label: 'Rows read', value: T.rowsRead, of: fmt(T.rows), tone: 'volt', meter: T.rowsRead / T.rows },
    { label: 'Data read', value: fmtBytes(T.bytesRead), of: fmtBytes(T.bytes), tone: 'cyan', meter: T.bytesRead / T.bytes },
    { label: 'Granules', value: T.granulesKept, of: T.granules, meter: T.granulesKept / T.granules },
    { label: 'Parts', value: T.partsKept, of: T.parts },
    { label: 'Columns', value: plan.readCols.length, of: nCols },
  ]

  const ghost = (cells: Cell[], duration = 600) => tint(ctx, cells, (c) => mix(P.slate, [c.r, c.g, c.b], 0.25), { a: 0.08, duration, glow: 0 })

  const steps: Step[] = []
  const warn = plan.warnings.length ? `<br/><em>${plan.warnings.join(' ')}</em>` : ''

  steps.push({
    title: 'The query reaches the initiator',
    body: `<code>${ds.distributed}</code> is a Distributed table over <b>${ds.shards.length} shards</b>, each holding ${T.parts / ds.shards.length} parts in ${T.partitions} monthly partitions. Every box is one granule of one column.${warn}`,
    code: plan.sql,
    async run() {
      ctx.stats([
        { label: 'Rows', value: fmt(T.rows) },
        { label: 'Parts', value: T.parts },
        { label: 'Granules', value: T.granules },
      ])
      await all(
        tw.to(initBox, { a: 1 }, { duration: 500 }),
        tw.to(initLabel, { o: 1 }, { duration: 500 }),
        tw.to([...shardLabels, ...colLabels, ...partitionLabels], { o: 1 }, { duration: 600, delay: tw.stagger(30) }),
        ...ds.shards.map((_, si) => tw.wait(si * 120).then(() => drop(ctx, cellsOf((g) => g.shard === si), { each: 0.9, duration: 650, from: 1.6 }))),
      )
    },
  })

  if (plan.trivialCount) {
    steps.push({
      title: 'Answered from metadata',
      body: 'Every part already knows its exact row count. A plain <code>count()</code> just adds those numbers up. <b>Zero granules</b> are read.',
      hold: 3200,
      async run() {
        await all(...ds.shards.flatMap((s) => s.parts.map((p) => tw.to(partOutlines.get(p)!, { o: 0.9, r: P.volt[0], g: P.volt[1], b: P.volt[2] }, { duration: 400 }))), ghost(gcells.map((g) => g.cell), 800))
        await all(...arcs.map((a) => tw.to(a.line, { o: 0.5 }, { duration: 400 })))
        await all(...arcs.map((a, i) => packet(ctx, a.path(1), a.path(0), { lift: 0, duration: 900, delay: i * 120, size: 0.16 })))
        resultLabel.set(`1 row · ${fmt(T.rows)}`)
        await tw.to(resultLabel, { o: 1 }, { duration: 400 })
        ctx.stats([
          { label: 'Rows read', value: 0, of: fmt(T.rows), tone: 'volt', meter: 0 },
          { label: 'Data read', value: '0 B', tone: 'cyan', meter: 0 },
          { label: 'Parts consulted', value: T.parts, tone: 'mist' },
        ])
      },
    })
    return { steps }
  }

  steps.push({
    title: `Fan out to ${ds.shards.length} shards`,
    body: 'The initiator sends the same query to one replica of every shard. From here on, each shard works on its own data in parallel.',
    async run() {
      await all(...arcs.map((a) => tw.to(a.line, { o: 0.5 }, { duration: 400 })), tw.to(nodes, { a: 1 }, { duration: 500 }))
      await all(...arcs.map((a, i) => packet(ctx, a.path(0), a.path(1), { lift: 0, duration: 900, delay: i * 90, size: 0.16 })))
      await all(...ds.shards.map((_, si) => tw.to(cellsOf((g) => g.shard === si), { glow: 0.25 }, { duration: 200 }).then(() => tw.to(cellsOf((g) => g.shard === si), { glow: 0 }, { duration: 500 }))))
    },
  })

  const unreadCols = cols.filter((c) => !readSet.has(c))
  steps.push({
    title: plan.star ? 'SELECT * opens every column' : `Only ${plan.readCols.length} of ${nCols} columns are read`,
    body: plan.star
      ? 'Columns live in separate files, so <code>SELECT *</code> has to open and decompress all of them, including the wide <code>url</code> column. Name the columns you need.'
      : `The query touches ${plan.readCols.map((c) => `<code>${c}</code>`).join(', ')}. The other column files (${unreadCols.map((c) => `<code>${c}</code>`).join(', ')}) are never opened.`,
    async run() {
      if (plan.star) {
        await tw.to(gcells.map((g) => g.cell), { glow: 0.3 }, { duration: 300 }).then(() => tw.to(gcells.map((g) => g.cell), { glow: 0 }, { duration: 500 }))
      } else {
        await all(
          ghost(cellsOf((g) => !readSet.has(g.col))),
          ...colLabels.map((l, ci) => tw.to(l, { o: readSet.has(cols[ci]) ? 1 : 0.25 }, { duration: 500 })),
        )
      }
      ctx.stats([
        { label: 'Columns', value: plan.readCols.length, of: nCols, tone: plan.star ? 'coral' : 'volt' },
        { label: 'Bytes per granule', value: fmtBytes(ds.columns.filter((c) => readSet.has(c.name)).reduce((s, c) => s + c.bytes, 0)), of: fmtBytes(ds.columns.reduce((s, c) => s + c.bytes, 0)) },
      ])
    },
  })

  const prunedParts = ds.shards.flatMap((s) => s.parts.filter((p) => !keptPart(p)))
  if (plan.usesPartition) {
    steps.push({
      title: `Partition pruning keeps ${T.partsKept} of ${T.parts} parts`,
      body:
        T.partsKept < T.parts
          ? `Each part stores the min and max <code>${ds.partitionColumns[0]}</code> it contains. Parts that can’t match the date filter are dropped before any data is read, whole months at a time.`
          : `The filter mentions <code>${ds.partitionColumns[0]}</code>, but every part’s min/max range could still match, so none can be skipped yet.`,
      async run() {
        const pruned = cellsOf((g) => !keptPart(g.part))
        await all(
          ghost(pruned, 700),
          ...prunedParts.map((p) => tw.to(partOutlines.get(p)!, { o: 0.25 }, { duration: 500 })),
          ...partitionLabels.map((l, i) => tw.to(l, { o: ds.shards[0].parts.some((p) => p.partition === partitions[i] && keptPart(p)) ? 1 : 0.3 }, { duration: 500 })),
        )
        ctx.stats([
          { label: 'Partitions', value: T.partitionsKept, of: T.partitions, tone: 'volt', meter: T.partitionsKept / T.partitions },
          { label: 'Parts', value: T.partsKept, of: T.parts, tone: 'volt', meter: T.partsKept / T.parts },
          { label: 'Granules left', value: T.granulesAfterPartition, of: T.granules },
        ])
      },
    })
  } else {
    steps.push({
      title: 'No partition filter: every month stays',
      body: `The table is partitioned by <code>${ds.partitionBy}</code>, but the query doesn’t filter on <code>${ds.partitionColumns[0]}</code>, so all ${T.partitions} months stay in play.`,
      async run() {
        await all(...partitionLabels.map((l) => tw.to(l, { o: 0.4 }, { duration: 300 }).then(() => tw.to(l, { o: 1 }, { duration: 400 }))))
      },
    })
  }

  const keyStr = `(${ds.orderBy.join(', ')})`
  const pkPruned = gcells.filter((g) => keptPart(g.part) && !keptGranule(g.g) && readSet.has(g.col))
  if (plan.earlyStop) {
    steps.push({
      title: 'LIMIT lets reading stop early',
      body: `Without <code>ORDER BY</code> or aggregation, any ${plan.query.limit} rows will do. Each shard stops after its first block, so ${T.granulesKept} of ${T.granules} granules are read.`,
      async run() {
        await ghost(pkPruned.map((g) => g.cell), 700)
        ctx.stats(baseStats())
      },
    })
  } else if (plan.keyColsUsed.length) {
    const lead = plan.keyColsUsed.includes(ds.orderBy[0])
    steps.push({
      title: `Primary key keeps ${T.granulesKept} of ${T.granulesAfterPartition} granules`,
      body: `The table is sorted by <code>${keyStr}</code>. ClickHouse checks the filter against each granule’s key range in <code>primary.idx</code> and skips every granule that can’t match.${lead ? '' : ` The filter only uses <code>${plan.keyColsUsed.join(', ')}</code>, not the leading key column, so skipping is limited.`}`,
      async run() {
        // a scan line sweeps each shard's sort order
        const sweeps = shardX.map((x) => ctx.cells.alloc({ x, y: 0.22, z: zShift - 0.2, w: nCols * CPX + 0.3, h: 0.015, d: 0.04, a: 0, glow: 1, color: P.volt }))
        const dur = 1500
        await all(
          tw.to(sweeps, { a: 1 }, { duration: 200 }),
          tw.to(sweeps, { z: zShift + depth + 0.2 }, { duration: dur, ease: 'inOutSine' }),
          ...pkPruned.map((g) => tw.wait(((g.cell.z - zShift) / depth) * dur).then(() => ghost([g.cell], 300))),
        )
        await tw.to(sweeps, { a: 0 }, { duration: 200 })
        ctx.cells.release(sweeps)
        ctx.stats([
          { label: 'Granules', value: T.granulesKept, of: T.granules, tone: 'volt', meter: T.granulesKept / T.granules },
          { label: 'Skipped by primary key', value: T.granulesAfterPartition - T.granulesKept, tone: 'cyan' },
        ])
      },
    })
  } else {
    steps.push({
      title: plan.nonKeyFilterCols.length ? 'The primary key can’t help here' : 'Nothing to skip: a full scan',
      body: plan.nonKeyFilterCols.length
        ? `The table is sorted by <code>${keyStr}</code>, but the filter is on <code>${plan.nonKeyFilterCols.join(', ')}</code>. Matching rows could be in any granule, so all of them are read. A different sort key, a projection or a skip index would help.`
        : `There is no condition on the sort key <code>${keyStr}</code>, so every remaining granule of the needed columns is read.`,
      async run() {
        const read = cellsOf((g) => keptPart(g.part) && readSet.has(g.col))
        await tw.to(read, { glow: 0.35 }, { duration: 300, delay: tw.stagger(1) }).then(() => tw.to(read, { glow: 0 }, { duration: 500 }))
        ctx.stats([{ label: 'Granules', value: T.granulesKept, of: T.granules, tone: plan.nonKeyFilterCols.length ? 'coral' : 'mist', meter: T.granulesKept / T.granules }])
      },
    })
  }

  const readCells = gcells.filter((g) => keptGranule(g.g) && readSet.has(g.col))
  steps.push({
    title: `Read ${fmt(T.rowsRead)} rows, ${fmtBytes(T.bytesRead)}`,
    body: `${pct(T.granulesKept, T.granules)}% of the granules and ${pct(T.bytesRead, T.bytes)}% of the table’s bytes are decompressed and filtered. ${plan.aggregate ? 'Each shard feeds them straight into its own aggregation.' : 'Matching rows stream toward the initiator.'}`,
    async run() {
      await tw.to(readCells.map((g) => g.cell), { glow: 0.55, y: 0.06 }, { duration: 400, delay: (_: unknown, i: number) => i * Math.min(6, 900 / Math.max(1, readCells.length)) })
      const sample = readCells.filter((_, i) => i % Math.max(1, Math.ceil(readCells.length / 70)) === 0)
      await stream(
        ctx,
        sample.map((g) => center(g.cell)),
        (i) => [shardX[sample[i].shard], 0.2, nodeZ],
        { lift: 0.8, duration: 700, each: 12, size: 0.09, color: (i) => COLUMN_HUES[cols.indexOf(sample[i].col) % COLUMN_HUES.length] },
      )
      await tw.to(readCells.map((g) => g.cell), { glow: 0.15 }, { duration: 500 })
      ctx.stats(baseStats())
    },
  })

  const groups = Math.max(1, Math.min(6, plan.resultRows ?? 6))
  steps.push({
    title: plan.aggregate ? 'Partial results merge on the initiator' : 'Rows flow back to the client',
    body: plan.aggregate
      ? `Every shard sends only its partial aggregation states, at most ${plan.resultRows !== null ? fmt(plan.resultRows) : 'a few'} rows, never the raw data. The initiator merges them${plan.query.orderBy.length ? ', sorts' : ''} and returns the result.`
      : `Without aggregation, every matching row travels to the initiator${plan.query.limit !== null ? `, which stops after ${plan.query.limit}` : ''}. Filtering early and selecting few columns keeps this cheap.`,
    hold: 4200,
    async run() {
      const partials = shardX.flatMap((x, si) =>
        Array.from({ length: groups }, (_, k) =>
          ctx.cells.alloc({ x: x + (k - (groups - 1) / 2) * 0.18, y: 0.12, z: nodeZ, w: 0.14, h: 0.02, d: 0.14, a: 1, glow: 0.4, color: COLUMN_HUES[k % COLUMN_HUES.length], data: { si, k } }),
        ),
      )
      await tw.to(partials, { h: (c: Cell) => 0.15 + ((c.data.k * 37 + c.data.si * 11) % 7) * 0.05 }, { duration: 500, ease: 'outBack' })
      await all(
        ...partials.map((c, i) => {
          const from = center(c)
          c.a = 0
          return packet(ctx, from, [initAt[0] + (c.data.k - (groups - 1) / 2) * 0.24, 0.6, initAt[2]], {
            color: [c.r, c.g, c.b],
            lift: 1.3,
            duration: 900,
            delay: i * 40,
            size: plan.aggregate ? 0.14 : 0.1,
          })
        }),
      )
      ctx.cells.release(partials)
      const finals = Array.from({ length: groups }, (_, k) =>
        ctx.cells.alloc({ x: initAt[0] + (k - (groups - 1) / 2) * 0.26, y: 0.32, z: initAt[2], w: 0.2, h: 0.02, d: 0.2, a: 1, glow: 0.5, color: COLUMN_HUES[k % COLUMN_HUES.length] }),
      )
      resultLabel.set(plan.resultRows !== null ? `${fmt(plan.resultRows)} row${plan.resultRows === 1 ? '' : 's'}` : 'rows stream')
      await all(
        tw.to(finals, { h: (_: Cell, i: number) => 0.25 + ((i * 53) % 9) * 0.07 }, { duration: 700, ease: 'outBack', delay: tw.stagger(60) }),
        tw.to(resultLabel, { o: 1 }, { duration: 500 }),
        fade(ctx, nodes, 0.6),
      )
      ctx.stats([
        ...baseStats().slice(0, 3),
        { label: 'Result', value: plan.resultRows !== null ? plan.resultRows : '—', unit: plan.resultRows !== null ? ' rows' : '', tone: 'violet' },
      ])
      await fit(ctx, FULL, { theta: -0.04, phi: 0.9, pad: 1.0, usable: 0.5, duration: 1200 })
    },
  })

  return { steps }
}
