import type { Cell } from '../engine/Cells'
import type { Label } from '../engine/World'
import { COLUMN_HUES, P, keyColor, mix, scale } from '../engine/palette'
import { all, center, drop, fit, fitRig, rng, setCamera, shuffle, spawn, stream, tint, type V3 } from './kit'
import type { SceneDef } from './types'

const G = 24
const GPX = 0.34
/** columns, smallest first, with their on-screen depth standing in for compressed size */
const COLS = [
  { name: 'town', note: 'LowCardinality · sort key', d: 0.18, hue: COLUMN_HUES[0] },
  { name: 'date', note: 'Date · 2 bytes', d: 0.22, hue: COLUMN_HUES[1] },
  { name: 'price', note: 'UInt32 · 4 bytes', d: 0.32, hue: COLUMN_HUES[4] },
  { name: 'street', note: 'String · wide', d: 1.0, hue: COLUMN_HUES[2] },
]
const LONDON = [7, 18] // granules selected by the primary index on town

const xAt = (g: number) => (g - (G - 1) / 2) * GPX
const zOf: number[] = []
{
  let z = -1.2
  for (const c of COLS) {
    zOf.push(z + c.d / 2)
    z += c.d + 0.22
  }
}

export const prewhere: SceneDef = {
  id: 'prewhere',
  title: 'PREWHERE',
  kicker: 'Filter first, read the rest later',
  blurb: 'Filter columns are read one by one, smallest first; wide columns only for surviving granules.',
  docs: 'https://clickhouse.com/docs/concepts/features/performance/prewhere',
  create(ctx) {
    const { world, tw } = ctx
    const rand = rng(31)

    const grid: Cell[][] = COLS.map((col, ci) =>
      Array.from({ length: G }, (_, g) =>
        spawn(ctx, {
          x: xAt(g),
          z: zOf[ci],
          w: 0.26,
          d: col.d,
          h: 0.14,
          color: ci === 0 ? keyColor(g / (G - 1)) : scale(col.hue, 0.62 + rand() * 0.2),
          data: { g, ci },
        }),
      ),
    )
    const all0 = grid.flat()
    // right-aligned against the table's left edge
    const labels: Label[] = COLS.map((c, ci) => world.label(`<span style="display:inline-block;transform:translateX(-50%)">${c.name} <span class="k">${c.note}</span></span>`, xAt(0) - 0.3, 0.02, zOf[ci], 'small', 0))

    const selected = Array.from({ length: LONDON[1] - LONDON[0] + 1 }, (_, i) => LONDON[0] + i)
    const afterDate = shuffle(selected, rand).slice(0, 7).sort((a, b) => a - b)
    const afterPrice = shuffle(afterDate, rand).slice(0, 3).sort((a, b) => a - b)
    const readAt: V3 = [xAt(G - 1) + 1.6, 1.2, zOf[3]]

    const ghost = (cells: Cell[], d = 500) => tint(ctx, cells, (c) => mix(P.slate, [c.r, c.g, c.b], 0.25), { a: 0.09, glow: 0, duration: d })
    const restore = (cells: Cell[]) =>
      tint(ctx, cells, (c) => (c.data.ci === 0 ? keyColor(c.data.g / (G - 1)) : scale(COLS[c.data.ci].hue, 0.72)), { a: 1, glow: 0, duration: 500 })
    const colCells = (ci: number, gs: number[]) => gs.map((g) => grid[ci][g])
    /** "read" a set of column granules: a glow wave plus packets to the reader. */
    const read = async (cells: Cell[], each = 35) => {
      await tw.to(cells, { glow: 0.45, y: 0.06 }, { duration: 300, delay: tw.stagger(each) })
      await stream(ctx, cells.map(center), readAt, { lift: 0.8, duration: 650, each: 18, size: 0.08, color: (i) => [cells[i].r, cells[i].g, cells[i].b] })
      await tw.to(cells, { glow: 0.15 }, { duration: 300 })
    }

    const BOX = { x0: xAt(0) - 2.4, x1: xAt(G - 1) + 1.9, z0: -1.6, z1: zOf[3] + 0.8 }
    setCamera(ctx, fitRig(ctx, BOX, { theta: -0.05, phi: 0.84, pad: 0.92 }))

    const byCol = (gs: number[][]) => gs.map((list) => list.length)
    const statsFor = (counts: number[], tone: 'volt' | 'coral') =>
      ctx.stats([
        ...COLS.map((c, ci) => ({ label: `${c.name} granules read`, value: counts[ci], of: selected.length, tone: ci === 3 ? tone : ('mist' as const), meter: counts[ci] / selected.length })),
      ])

    return {
      steps: [
        {
          title: 'The primary index picks the granules',
          body: 'The table is sorted by <code>town</code>, so the primary index narrows the query to the London granules. Every box is one granule of one column; its depth stands for the column’s size on disk.',
          code: "SELECT street FROM uk_price_paid\nWHERE town = 'LONDON' AND date > '2024-12-31' AND price < 10000",
          async run() {
            await all(drop(ctx, all0, { each: 1.5, duration: 700 }), tw.to(labels, { o: 1 }, { duration: 600, delay: 400 }))
            const out = all0.filter((c) => c.data.g < LONDON[0] || c.data.g > LONDON[1])
            await ghost(out, 700)
            ctx.stats([{ label: 'Granules after primary index', value: selected.length, of: G, tone: 'volt', meter: selected.length / G }])
          },
        },
        {
          title: 'Without PREWHERE: every column, every granule',
          body: 'A plain read loads all needed columns for all selected granules, then filters. The wide <code>street</code> column is read in full even though almost none of its rows survive.',
          async run() {
            await read(COLS.flatMap((_, ci) => colCells(ci, selected)), 8)
            ctx.stats([
              { label: 'Data read (docs example)', value: '23.36 MB', tone: 'coral' },
              { label: 'Elapsed', value: '0.056 s', tone: 'coral' },
              { label: 'street granules read', value: selected.length, of: selected.length, tone: 'coral', meter: 1 },
            ])
          },
        },
        {
          title: 'PREWHERE reads the smallest filter column first',
          body: 'With PREWHERE, ClickHouse evaluates one filter column at a time, smallest first. Only granules that still contain a matching row move on to the next column.',
          async run() {
            await restore(COLS.flatMap((_, ci) => colCells(ci, selected)))
            await tw.to(COLS.flatMap((_, ci) => colCells(ci, selected)), { y: 0 }, { duration: 200 })
            await read(colCells(1, selected))
            const drop1 = selected.filter((g) => !afterDate.includes(g))
            await ghost(COLS.slice(2).flatMap((_, k) => colCells(k + 2, drop1)))
            statsFor(byCol([selected, selected, [], []]), 'volt')
          },
        },
        {
          title: 'Each filter shrinks the next read',
          body: `<code>price</code> is read only for the ${afterDate.length} granules that passed the date filter. After it, just ${afterPrice.length} granules still hold matching rows.`,
          async run() {
            await read(colCells(2, afterDate))
            const drop2 = afterDate.filter((g) => !afterPrice.includes(g))
            await ghost(colCells(3, drop2))
            statsFor(byCol([selected, selected, afterDate, []]), 'volt')
          },
        },
        {
          title: 'The wide column is read last, for survivors only',
          body: 'Finally <code>street</code> is read for the few surviving granules. The same rows are processed, but far less data is loaded: 6.74 MB instead of 23.36 MB in the docs example, 3× faster.',
          hold: 3200,
          async run() {
            await read(colCells(3, afterPrice), 120)
            ctx.stats([
              { label: 'Data read (docs example)', value: '6.74 MB', of: '23.36 MB', tone: 'volt', meter: 6.74 / 23.36 },
              { label: 'Elapsed', value: '0.017 s', of: '0.056 s', tone: 'cyan' },
              { label: 'street granules read', value: afterPrice.length, of: selected.length, tone: 'volt', meter: afterPrice.length / selected.length },
            ])
          },
        },
        {
          title: 'You rarely write it yourself',
          body: 'Since 23.2, <code>optimize_move_to_prewhere</code> moves WHERE conditions into PREWHERE automatically and orders them by column size. <code>EXPLAIN</code> shows the resulting <em>Prewhere filter</em>.',
          code: "EXPLAIN SELECT street FROM uk_price_paid\nWHERE town = 'LONDON' AND date > '2024-12-31' AND price < 10000\n-- Prewhere filter column: and(...)",
          hold: 3600,
          async run() {
            await fit(ctx, BOX, { theta: -0.12, phi: 0.86, pad: 0.92, duration: 1600 })
            await tw.to(colCells(3, afterPrice), { glow: 0.4 }, { duration: 400 }).then(() => tw.to(colCells(3, afterPrice), { glow: 0.15 }, { duration: 600 }))
          },
        },
      ],
    }
  },
}
