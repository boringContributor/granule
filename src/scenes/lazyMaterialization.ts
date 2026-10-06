import type { Cell } from '../engine/Cells'
import type { Label } from '../engine/World'
import { COLUMN_HUES, P, keyColor, mix, scale } from '../engine/palette'
import { all, center, drop, fit, fitRig, packet, rng, setCamera, spawn, tint, type V3 } from './kit'
import type { SceneDef } from './types'

const G = 28
const GPX = 0.32
const COLS = [
  { name: 'helpful_votes', note: 'UInt32', d: 0.2, hue: COLUMN_HUES[4] },
  { name: 'star_rating', note: 'UInt8', d: 0.14, hue: COLUMN_HUES[0] },
  { name: 'product_title', note: 'String', d: 0.45, hue: COLUMN_HUES[1] },
  { name: 'review_body', note: 'String · very wide', d: 1.2, hue: COLUMN_HUES[2] },
]
const xAt = (g: number) => (g - (G - 1) / 2) * GPX
const zOf: number[] = []
{
  let z = -1.4
  for (const c of COLS) {
    zOf.push(z + c.d / 2)
    z += c.d + 0.22
  }
}

export const lazyMaterialization: SceneDef = {
  id: 'lazy-materialization',
  title: 'Lazy materialization',
  kicker: 'Read wide columns only for the winners',
  blurb: 'Top-N queries read the sort column for every row, but the other columns only for the final rows.',
  docs: 'https://clickhouse.com/docs/concepts/features/performance/lazy-materialization',
  create(ctx) {
    const { world, tw, cells } = ctx
    const rand = rng(77)

    // max helpful_votes per granule; three granules hold the winners
    const votes = Array.from({ length: G }, () => 0.12 + rand() * 0.45)
    const winners = [5, 16, 23]
    winners.forEach((g, i) => (votes[g] = 1 - i * 0.12))

    const grid: Cell[][] = COLS.map((col, ci) =>
      Array.from({ length: G }, (_, g) =>
        spawn(ctx, {
          x: xAt(g),
          z: zOf[ci],
          w: 0.24,
          d: col.d,
          h: ci === 0 ? 0.08 + votes[g] * 0.5 : 0.14,
          color: ci === 0 ? keyColor(0.25 + votes[g] * 0.75) : scale(col.hue, 0.55 + rand() * 0.2),
          data: { g, ci },
        }),
      ),
    )
    const all0 = grid.flat()
    const labels: Label[] = COLS.map((c, ci) =>
      world.label(`<span style="display:inline-block;transform:translateX(-50%)">${c.name} <span class="k">${c.note}</span></span>`, xAt(0) - 0.3, 0.02, zOf[ci], 'small', 0),
    )
    const resultAt: V3 = [xAt(G - 1) + 2.1, 0, zOf[1]]
    const resultRows = winners.map((_, i) => cells.alloc({ x: resultAt[0], y: 0.02 + i * 0.22, z: resultAt[2], w: 1.0, h: 0.16, d: 0.5, a: 0, color: mix(P.volt, P.slate, 0.45) }))
    const resultLabel = world.label('<span class="k">LIMIT 3</span>result', resultAt[0], 0.95, resultAt[2], 'tag volt', 0)

    const ghost = (list: Cell[], d = 500) => tint(ctx, list, (c) => mix(P.slate, [c.r, c.g, c.b], 0.25), { a: 0.09, glow: 0, duration: d })
    const restore = (list: Cell[]) =>
      tint(ctx, list, (c) => (c.data.ci === 0 ? keyColor(0.25 + votes[c.data.g] * 0.75) : scale(COLS[c.data.ci].hue, 0.65)), { a: 1, glow: 0, duration: 500 })

    const BOX = { x0: xAt(0) - 2.6, x1: resultAt[0] + 0.7, z0: -1.8, z1: zOf[3] + 0.8 }
    setCamera(ctx, fitRig(ctx, BOX, { theta: -0.06, phi: 0.84, pad: 0.92 }))

    return {
      steps: [
        {
          title: 'A top-N query',
          body: 'Find the three Amazon reviews with the most helpful votes, with their title and full text. Box height in the first row shows each granule’s highest vote count.',
          code: 'SELECT helpful_votes, product_title, review_body\nFROM amazon.amazon_reviews\nORDER BY helpful_votes DESC\nLIMIT 3',
          async run() {
            await all(drop(ctx, all0, { each: 1.2, duration: 700 }), tw.to(labels, { o: 1 }, { duration: 600, delay: 400 }))
            ctx.stats([{ label: 'Rows', value: '150M' }, { label: 'Granules', value: G, unit: ' shown' }])
          },
        },
        {
          title: 'Eager reading loads everything',
          body: 'Without lazy materialization, every selected column is read for every row before sorting, including gigabytes of review text for rows that are thrown away right after.',
          async run() {
            await tw.to(all0, { glow: 0.4 }, { duration: 300, delay: (c: Cell) => c.data.g * 25 })
            await tw.to(all0, { glow: 0.12 }, { duration: 500 })
            ctx.stats([
              { label: 'Data read (docs)', value: '71.38 GB', tone: 'coral' },
              { label: 'Elapsed', value: '219 s', tone: 'coral' },
              { label: 'Peak memory', value: '1.11 GiB', tone: 'coral' },
            ])
          },
        },
        {
          title: 'Lazily: only the sort column is read',
          body: 'With lazy materialization, ClickHouse reads just <code>helpful_votes</code> for all rows. The wide columns stay closed for now; they are only placeholders in the plan.',
          async run() {
            await all(restore(all0), ghost(all0.filter((c) => c.data.ci > 0), 700))
            await tw.to(grid[0], { glow: 0.35 }, { duration: 300, delay: tw.stagger(25) })
            await tw.to(grid[0], { glow: 0.1 }, { duration: 400 })
            ctx.stats([
              { label: 'Columns read', value: 1, of: COLS.length, tone: 'volt' },
              { label: 'Rows scanned', value: '150M', tone: 'cyan' },
            ])
          },
        },
        {
          title: 'Sort and keep the top 3',
          body: 'The sort keeps only the three largest vote counts and remembers where each of those rows lives.',
          async run() {
            const win = winners.map((g) => grid[0][g])
            await all(
              tint(ctx, grid[0].filter((c) => !winners.includes(c.data.g)), (c) => mix(P.slate, [c.r, c.g, c.b], 0.4), { a: 0.35, duration: 600 }),
              tw.to(win, { glow: 0.5 }, { duration: 500 }),
            )
            await all(...win.map((c, i) => packet(ctx, center(c), [resultAt[0] - 0.3, 0.1 + i * 0.22, resultAt[2]], { color: [c.r, c.g, c.b], lift: 1.2, duration: 900, delay: i * 150 })))
            await all(tw.to(resultRows, { a: 0.35 }, { duration: 300 }), tw.to(resultLabel, { o: 1 }, { duration: 400 }))
          },
        },
        {
          title: 'Then fetch the rest for just 3 rows',
          body: 'Only now are <code>product_title</code> and <code>review_body</code> read, and only for the three winning rows. Everything else in those columns is never touched.',
          hold: 3400,
          async run() {
            const slices: Cell[] = []
            for (const g of winners)
              for (const ci of [2, 3]) {
                const src = grid[ci][g]
                slices.push(cells.alloc({ x: src.x, y: 0, z: src.z, w: 0.07, h: 0.2, d: src.d, a: 0, glow: 0.5, color: mix(COLS[ci].hue, P.white, 0.3), data: { g, ci } }))
              }
            await tw.to(slices, { a: 1 }, { duration: 400, delay: tw.stagger(80) })
            await all(...slices.map((c, i) => packet(ctx, center(c), [resultAt[0] + 0.1, 0.1 + winners.indexOf(c.data.g) * 0.22, resultAt[2]], { color: [c.r, c.g, c.b], lift: 1, duration: 900, delay: i * 90 })))
            await tw.to(resultRows, { a: 1, glow: 0.08 }, { duration: 500 })
            await tw.to(slices, { glow: 0.15 }, { duration: 400 })
            ctx.stats([
              { label: 'Data read (docs)', value: '1.81 GB', of: '71.38 GB', tone: 'volt', meter: 1.81 / 71.38 },
              { label: 'Elapsed', value: '0.139 s', of: '219 s', tone: 'cyan' },
              { label: 'Peak memory', value: '3.80 MiB', of: '1.11 GiB', tone: 'violet' },
            ])
          },
        },
        {
          title: 'On by default',
          body: 'Since 25.4, <code>query_plan_optimize_lazy_materialization</code> is on by default. <code>EXPLAIN actions = 1</code> lists the deferred columns as <em>Lazily read columns</em>. In the docs example the query got about 1,576× faster.',
          code: 'EXPLAIN actions = 1\nSELECT helpful_votes, product_title, review_body\nFROM amazon.amazon_reviews ORDER BY helpful_votes DESC LIMIT 3\n-- Lazily read columns: product_title, review_body',
          hold: 3600,
          async run() {
            await fit(ctx, BOX, { theta: -0.14, phi: 0.86, pad: 0.92, duration: 1600 })
          },
        },
      ],
    }
  },
}
