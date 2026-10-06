import type { Cell } from '../engine/Cells'
import type { Label, LineHandle } from '../engine/World'
import { COLUMN_HUES, P, mix, scale, type RGB } from '../engine/palette'
import { all, drop, fade, fit, fitRig, rng, setCamera, spawn, tint } from './kit'
import type { SceneDef } from './types'

const MONTHS = ['2020-09', '2020-10', '2020-11', '2020-12']
const MONTH_HUE: RGB[] = [COLUMN_HUES[0], COLUMN_HUES[1], COLUMN_HUES[2], COLUMN_HUES[4]]
const COLS = 3
const CPX = 0.5
const GPZ = 0.34
const LANE_W = 3.4
const ROWS_PER_INSERT = 3 // granule rows per month in one insert
const laneX = (m: number) => (m - 1.5) * 3.7
const LANE_Z0 = -1.2
const pid = (m: number) => MONTHS[m].replace('-', '') + '01'

interface Part {
  month: number
  min: number
  max: number
  name: string
  rows: Cell[][]
  label: Label
  minmax: Label
  x: number
}

export const partitions: SceneDef = {
  id: 'partitions',
  title: 'Table partitions',
  kicker: 'Group parts, prune whole months',
  blurb: 'PARTITION BY splits inserts into one part per partition value, enabling pruning and cheap lifecycle operations.',
  docs: 'https://clickhouse.com/docs/concepts/core-concepts/partitions',
  create(ctx) {
    const { world, tw, cells } = ctx
    const rand = rng(23)
    let block = 0
    const parts: Part[] = []
    const lanes: { outline: LineHandle; label: Label }[] = MONTHS.map((_, m) => ({
      outline: world.rect(laneX(m), 0.005, LANE_Z0 + 1.7, LANE_W, 4.4, P.steel, 0, true),
      label: world.label(`<span class="k">partition</span>${pid(m)}`, laneX(m), 0.02, LANE_Z0 - 0.75, 'small', 0),
    }))

    const cellColor = (m: number, c: number) => scale(MONTH_HUE[m], [1, 0.8, 0.64][c])
    const partColor = (p: Part) => (c: Cell) => cellColor(p.month, c.data.c)

    /** Slots inside a lane: up to two parts side by side, or one merged part in the middle. */
    const slotX = (m: number, i: number, n: number) => laneX(m) + (n === 1 ? 0 : (i - 0.5) * 1.62)
    const cellPos = (x: number, g: number, c: number) => ({ x: x + (c - 1) * CPX, z: LANE_Z0 + 0.25 + g * GPZ })

    const laneParts = (m: number) => parts.filter((p) => p.month === m)

    const relayout = (m: number, duration = 800, skip: Part[] = []) => {
      const ps = laneParts(m)
      const jobs: Promise<void>[] = []
      ps.forEach((p, i) => {
        p.x = slotX(m, i, ps.length)
        if (skip.includes(p)) {
          jobs.push(tw.to([p.label, p.minmax], { x: p.x }, { duration: 1 }))
          return
        }
        p.rows.forEach((row, g) =>
          row.forEach((c, ci) => {
            const t = cellPos(p.x, g, ci)
            jobs.push(tw.to(c, { x: t.x, z: t.z }, { duration, ease: 'inOutCubic' }))
          }),
        )
        jobs.push(tw.to([p.label, p.minmax], { x: p.x }, { duration, ease: 'inOutCubic' }))
      })
      return all(...jobs)
    }

    /** INSERT, phase 1: a mixed block of rows hovers above the table. */
    const stage = async (d: number) => {
      const fresh: Part[] = MONTHS.map((_, m) => {
        const rows = Array.from({ length: ROWS_PER_INSERT }, () =>
          Array.from({ length: COLS }, (_, c) => cells.alloc({ w: 0.42, d: 0.26, h: 0.16, a: 0, color: cellColor(m, c), data: { c, m } })),
        )
        const day0 = 1 + Math.floor(rand() * 4)
        const day1 = 26 + Math.floor(rand() * 4)
        const b = ++block
        const part: Part = {
          month: m,
          min: b,
          max: b,
          name: `${pid(m)}_${b}_${b}_0`,
          rows,
          label: world.label('', 0, 0.02, LANE_Z0 - 0.3, 'small', 0),
          minmax: world.label(`<span>${MONTHS[m].slice(5)}-${String(day0).padStart(2, '0')} … ${MONTHS[m].slice(5)}-${day1}</span>`, 0, 0.02, 0, 'mark', 0),
          x: 0,
        }
        part.label.set(part.name)
        return part
      })
      parts.push(...fresh)
      // the mixed block: every cell starts in a shuffled grid above the centre
      const mixed = fresh.flatMap((p) => p.rows.flat())
      // interleave months so the block looks mixed (7 is coprime with 36)
      const W = 9
      mixed.forEach((_, i) => {
        const c = mixed[(i * 7) % mixed.length]
        c.x = (i % W - (W - 1) / 2) * 0.5
        c.z = (Math.floor(i / W) - 1.5) * 0.38 + 0.6
        c.y = 2.6
      })
      await all(tw.to(mixed, { a: 1 }, { duration: d * 0.5, delay: tw.stagger(8) }), tw.to(mixed, { y: 2 }, { duration: d, ease: 'outCubic' }))
      return fresh
    }

    /** INSERT, phase 2: the block splits by partition key into one new part per month. */
    const split = async (fresh: Part[], d: number) => {
      for (let m = 0; m < MONTHS.length; m++) {
        const ps = laneParts(m)
        ps.forEach((p, i) => (p.x = slotX(m, i, ps.length)))
      }
      await all(
        ...fresh.map((p) => {
          const ps = laneParts(p.month)
          return all(
            relayout(p.month, d, fresh),
            ...p.rows.flatMap((row, g) =>
              row.map((c, ci) => {
                const t = cellPos(slotX(p.month, ps.indexOf(p), ps.length), g, ci)
                return tw.to(c, { x: t.x, z: t.z, y: 0 }, { duration: d, ease: 'inOutCubic', delay: g * 40 + ci * 20 })
              }),
            ),
          )
        }),
      )
      fresh.forEach((p) => {
        p.minmax.z = LANE_Z0 + 0.25 + p.rows.length * GPZ + 0.3
      })
      await tw.to(fresh.map((p) => p.label), { o: 1 }, { duration: 400 })
      return fresh
    }

    let staged: Part[] = []
    const ALL = { x0: -7.4, x1: 7.4, z0: -2.3, z1: 3 }
    setCamera(ctx, fitRig(ctx, ALL, { theta: -0.04, phi: 0.84 }))

    const statParts = (tone: 'volt' | 'coral' = 'volt') =>
      ctx.stats([
        { label: 'Active parts', value: parts.length, tone },
        { label: 'Partitions', value: new Set(parts.map((p) => p.month)).size },
      ])

    return {
      steps: [
        {
          title: 'One INSERT, rows from several months',
          body: 'The table is partitioned by month. A single insert brings rows from September to December, colored here by month.',
          code: 'CREATE TABLE uk_price_paid_partitioned (...)\nENGINE = MergeTree\nPARTITION BY toStartOfMonth(date)\nORDER BY (town, street)',
          async run() {
            staged = await stage(1200)
            ctx.stats([{ label: 'Rows in insert', value: '4 months' }])
          },
        },
        {
          title: 'One part per partition',
          body: 'ClickHouse splits the block by the partition key and writes <b>one part per month</b>, each sorted and compressed on its own. Partition IDs prefix the part names.',
          async run() {
            await all(...lanes.map((l) => tw.to(l.outline, { o: 0.55 }, { duration: 500 })), ...lanes.map((l) => tw.to(l.label, { o: 1 }, { duration: 500 })))
            await split(staged, 1300)
            statParts()
          },
        },
        {
          title: 'Each part keeps a MinMax index',
          body: 'For every part ClickHouse stores the <b>min and max</b> of the partition-key columns, here <code>date</code>. That tiny index is what lets queries skip whole parts.',
          async run() {
            await all(
              ...parts.map((p) => tw.to(p.minmax, { o: 1 }, { duration: 500 })),
              ...parts.map((p) => tint(ctx, p.rows.flat(), (c) => mix(cellColor(p.month, c.data.c), P.white, 0.18), { glow: 0.25, duration: 400 })),
            )
            await all(...parts.map((p) => tw.to(p.rows.flat(), { glow: 0 }, { duration: 500 })), ...parts.map((p) => tint(ctx, p.rows.flat(), partColor(p), { duration: 500 })))
          },
        },
        {
          title: 'Merges stay inside a partition',
          body: 'The next insert adds another part to every month. Background merges combine parts <b>within</b> a partition only; parts of different months are never merged together.',
          async run() {
            await split(await stage(800), 1000)
            statParts()
            await tw.wait(300)
            // merge the two parts of each month
            const jobs: Promise<unknown>[] = []
            for (let m = 0; m < MONTHS.length; m++) {
              const [a, b] = laneParts(m)
              const rows = [...a.rows, ...b.rows]
              const name = `${pid(m)}_${a.min}_${b.max}_1`
              const merged: Part = {
                month: m,
                min: a.min,
                max: b.max,
                name,
                rows,
                label: world.label(name, laneX(m), 0.02, LANE_Z0 - 0.3, 'small', 0),
                minmax: world.label(`<span>${MONTHS[m].slice(5)}-01 … ${MONTHS[m].slice(5)}-30</span>`, laneX(m), 0.02, LANE_Z0 + 0.25 + rows.length * GPZ + 0.3, 'mark', 0),
                x: laneX(m),
              }
              const flat = rows.flat()
              jobs.push(
                (async () => {
                  await all(tw.to([a.label, b.label, a.minmax, b.minmax], { o: 0 }, { duration: 300 }), tw.to(flat, { y: 0.8, glow: 0.2 }, { duration: 400, delay: tw.stagger(4) }))
                  parts.splice(parts.indexOf(a), 1)
                  parts.splice(parts.indexOf(b), 1)
                  parts.push(merged)
                  await all(
                    ...rows.flatMap((row, g) =>
                      row.map((c, ci) => {
                        const t = cellPos(laneX(m), g, ci)
                        return tw.to(c, { x: t.x, z: t.z }, { duration: 900, ease: 'inOutCubic', delay: g * 30 })
                      }),
                    ),
                  )
                  await tw.to(flat, { y: 0, glow: 0 }, { duration: 350, ease: 'inQuad' })
                  for (const l of [a.label, b.label, a.minmax, b.minmax]) world.removeLabel(l)
                  await tw.to([merged.label, merged.minmax], { o: 1 }, { duration: 400 })
                })(),
              )
            }
            await all(...jobs)
            statParts()
          },
        },
        {
          title: 'Prune partitions first, then granules',
          body: 'A filter on <code>date</code> is checked against each part’s MinMax index: whole months drop out. The primary index then skips granules inside the parts that remain. In the docs’ example: <b>3,257 → 11 granules</b>.',
          code: "SELECT max(price) FROM uk_price_paid_partitioned\nWHERE date >= '2020-12-01' AND town = 'LONDON'",
          hold: 2800,
          async run() {
            const out = parts.filter((p) => p.month !== 3)
            const dec = parts.find((p) => p.month === 3)!
            await all(
              ...out.map((p) => tint(ctx, p.rows.flat(), (c) => mix(P.slate, [c.r, c.g, c.b], 0.25), { a: 0.1, duration: 700 })),
              ...out.map((p) => tw.to([p.label, p.minmax], { o: 0.3 }, { duration: 500 })),
              ...lanes.slice(0, 3).map((l) => tw.to(l.outline, { o: 0.15 }, { duration: 500 })),
            )
            ctx.stats([
              { label: 'Partitions', value: 1, of: 4, tone: 'volt', meter: 0.25 },
              { label: 'Granules', value: dec.rows.length, of: parts.reduce((s, p) => s + p.rows.length, 0) },
            ])
            const keep = [2, 3]
            const skipRows = dec.rows.filter((_, g) => !keep.includes(g))
            await all(
              tint(ctx, skipRows.flat(), (c) => mix(P.slate, [c.r, c.g, c.b], 0.3), { a: 0.14, duration: 600, each: 8 }),
              tw.to(keep.flatMap((g) => dec.rows[g]), { glow: 0.4, y: 0.06 }, { duration: 600 }),
            )
            ctx.stats([
              { label: 'Partitions', value: 1, of: 4, tone: 'volt', meter: 0.25 },
              { label: 'Granules read', value: keep.length, of: parts.reduce((s, p) => s + p.rows.length, 0), tone: 'cyan', meter: keep.length / 24 },
            ])
          },
        },
        {
          title: 'Drop or move whole partitions',
          body: 'Partitions make data lifecycle cheap. A TTL or <code>DROP PARTITION</code> removes all parts of a month at once, with no rewrite. Older months can move to cheaper storage as whole parts.',
          code: "ALTER TABLE uk_price_paid_partitioned DROP PARTITION '2020-09-01'",
          hold: 2400,
          async run() {
            // restore colors
            await all(
              ...parts.map((p) => tint(ctx, p.rows.flat(), partColor(p), { a: 1, glow: 0, duration: 500 })),
              tw.to(parts.flatMap((p) => p.rows.flat()), { y: 0 }, { duration: 400 }),
              ...parts.map((p) => tw.to([p.label, p.minmax], { o: 1 }, { duration: 400 })),
              ...lanes.map((l) => tw.to(l.outline, { o: 0.55 }, { duration: 400 })),
            )
            const sep = parts.find((p) => p.month === 0)!
            const oct = parts.find((p) => p.month === 1)!
            await all(
              tw.to(sep.rows.flat(), { y: 1.2, a: 0 }, { duration: 900, ease: 'inQuad', delay: tw.stagger(6) }),
              tw.to([sep.label, sep.minmax, lanes[0].label], { o: 0 }, { duration: 700 }),
              tw.to(lanes[0].outline, { o: 0 }, { duration: 800 }),
            )
            parts.splice(parts.indexOf(sep), 1)
            // October moves to a cold tier
            const cold = world.label('<span class="k">moved to</span>cold storage', laneX(1), 0.02, LANE_Z0 + 2.6, 'tag cyan', 0)
            await all(
              tint(ctx, oct.rows.flat(), (c) => mix(P.steel, cellColor(1, c.data.c), 0.35), { duration: 800 }),
              tw.to(cold, { o: 1 }, { duration: 600 }),
            )
            statParts()
          },
        },
        {
          title: 'Keep the partition key coarse',
          body: 'Partition by something with too many values and every insert shatters into tiny parts that can never merge across partitions: <b>Too many parts</b>. Aim for &lt;1,000–10,000 partitions. Queries that don’t filter on the key also slow down: <b>12 → 90 ms</b> in the docs.',
          hold: 4000,
          async run() {
            const tiny: Cell[] = []
            const GX = 22
            for (let i = 0; i < 66; i++) {
              tiny.push(
                spawn(ctx, {
                  x: (i % GX - (GX - 1) / 2) * 0.55,
                  z: 3.7 + Math.floor(i / GX) * 0.5,
                  w: 0.22,
                  d: 0.2,
                  h: 0.12,
                  color: MONTH_HUE[i % 4],
                }),
              )
            }
            const warn = world.label('TOO_MANY_PARTS', 0, 1.2, 4.5, 'tag coral', 0)
            const keyTag = world.label('<span class="k">PARTITION BY</span>(date, town)', -5.2, 0.02, 3.15, 'tag', 0)
            await all(
              fit(ctx, { x0: -7.4, x1: 7.4, z0: -2.3, z1: 5.4 }, { theta: -0.04, phi: 0.86, duration: 1200 }),
              tw.to(keyTag, { o: 1 }, { duration: 400 }),
              drop(ctx, tiny, { each: 30, duration: 600, from: 2 }),
              ...Array.from({ length: 11 }, (_, k) =>
                tw.wait(k * 180).then(() =>
                  ctx.stats([
                    { label: 'Active parts', value: parts.length + (k + 1) * 6, tone: k > 5 ? 'coral' : 'volt' },
                    { label: 'Partitions', value: 3 + (k + 1) * 6, tone: k > 5 ? 'coral' : 'mist' },
                  ]),
                ),
              ),
            )
            await all(tw.to(warn, { o: 1 }, { duration: 400 }), fade(ctx, tiny, 1, { glow: 0.15 }))
            ctx.stats([
              { label: 'Active parts', value: parts.length + 66, tone: 'coral' },
              { label: 'Partitions', value: 69, tone: 'coral' },
              { label: 'Unfiltered query', value: '12 → 90', unit: ' ms', tone: 'coral' },
            ])
          },
        },
      ],
    }
  },
}
