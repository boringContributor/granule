import type { Cell } from '../engine/Cells'
import { COLUMN_HUES, P, keyColor, mix, scale } from '../engine/palette'
import { all, center, drop, fade, fit, fitRig, rng, setCamera, spawn, stream, tint } from './kit'
import type { SceneDef } from './types'

const G = 24
const COLS = ['ts', 'user_id', 'url']
const CPZ = 0.62
const GPX = 0.3
const MARK_Z = 2.3
const START = 9 * 60 // 09:00
const STEP = 7 // minutes per granule
const LO = 10 * 60 + 40
const HI = 11 * 60 + 5

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const keyAt = (g: number) => START + g * STEP
const xAt = (g: number) => (g - (G - 1) / 2) * GPX
const zCol = (c: number) => (c - 1) * CPZ - 0.4

export const sparseIndex: SceneDef = {
  id: 'primary-indexes',
  title: 'Primary indexes',
  docs: 'https://clickhouse.com/docs/concepts/core-concepts/primary-indexes',
  kicker: 'One mark per 8,192 rows',
  blurb: 'The primary index is tiny, lives in memory, and narrows a scan with a binary search.',
  create(ctx) {
    const { world, tw } = ctx
    const rand = rng(5)

    const grid: Cell[][] = Array.from({ length: G }, (_, g) =>
      COLS.map((_, c) => {
        const color =
          c === 0 ? keyColor(g / (G - 1)) : c === 1 ? mix(COLUMN_HUES[2], P.white, rand() * 0.35) : scale(COLUMN_HUES[1], 0.5 + rand() * 0.25)
        return spawn(ctx, { x: xAt(g), z: zCol(c), w: 0.24, d: 0.5, h: 0.16, color, data: { g, c } })
      }),
    )
    const cells = grid.flat()
    const marks = Array.from({ length: G }, (_, g) =>
      ctx.cells.alloc({ x: xAt(g), y: 0, z: MARK_Z, w: 0.2, h: 0.2, d: 0.2, a: 0, color: keyColor(g / (G - 1)), data: { g } }),
    )
    const links = Array.from({ length: G }, (_, g) =>
      world.polyline(
        [
          [xAt(g), 0.1, MARK_Z - 0.15],
          [xAt(g), 0.1, zCol(2) + 0.35],
        ],
        P.steel,
        0,
        true,
      ),
    )
    const markLabels = Array.from({ length: G }, (_, g) => world.label(`<span>${hhmm(keyAt(g))}</span>`, xAt(g), 0.02, MARK_Z + 0.32, 'mark', 0))
    const colLabels = COLS.map((n, c) => world.label(`${n}.bin`, xAt(0) - 0.75, 0.02, zCol(c), 'small', 0))
    const idxTitle = world.label('primary.idx', xAt(0) - 1.05, 0.02, MARK_Z, 'small', 0)
    const probeTag = world.label('', 0, 0.9, MARK_Z, 'tag', 0)
    const readAt: [number, number, number] = [xAt(G - 1) + 1.4, 1.4, -1.8]

    // selected granule range: last mark <= LO .. last mark <= HI
    let first = 0
    let last = 0
    for (let g = 0; g < G; g++) {
      if (keyAt(g) <= LO) first = g
      if (keyAt(g) <= HI) last = g
    }

    setCamera(ctx, fitRig(ctx, { x0: -4.6, x1: 4.6, z0: -1.4, z1: 2.9 }, { theta: 0, phi: 0.86 }))

    const probe = async (g: number, text: string, skip: number[], tone: 'coral' | 'volt') => {
      const m = marks[g]
      probeTag.x = m.x
      probeTag.el.className = `lbl tag ${tone}`
      probeTag.set(text)
      await all(tw.to(m, { glow: 0.8, y: 0.25 }, { duration: 300 }), tw.to(probeTag, { o: 1 }, { duration: 250 }), tw.to(markLabels[g], { o: 1 }, { duration: 200 }))
      await tw.wait(650)
      const dimMarks = skip.map((i) => marks[i])
      await all(
        tw.to(m, { glow: 0, y: 0 }, { duration: 300 }),
        tw.to(probeTag, { o: 0 }, { duration: 250 }),
        tint(ctx, dimMarks, P.steel, { a: 0.25, duration: 450 }),
        ...skip.map((i) => tw.to(links[i], { o: 0.04 }, { duration: 400 })),
        ...skip.map((i) => tw.to(markLabels[i], { o: 0 }, { duration: 300 })),
        tint(
          ctx,
          skip.flatMap((i) => grid[i]),
          (c) => mix(P.slate, [c.r, c.g, c.b], 0.2),
          { a: 0.1, duration: 500 },
        ),
      )
    }

    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

    return {
      steps: [
        {
          title: 'A part, sorted by ts',
          body: 'Each row of boxes is a <b>granule</b>: 8,192 consecutive rows of every column. Because the part is sorted by <code>ts</code>, the key column reads as one smooth ramp.',
          code: 'ORDER BY ts   -- index_granularity = 8192',
          async run() {
            await all(drop(ctx, cells, { each: 8, duration: 800 }), tw.to(colLabels, { o: 1 }, { duration: 800, delay: 400 }))
            ctx.stats([
              { label: 'Rows', value: G * 8192 },
              { label: 'Granules', value: G },
            ])
          },
        },
        {
          title: 'primary.idx keeps one entry per granule',
          body: 'For every granule the index stores only the key of its <b>first row</b>. That’s 24 entries for ~200K rows, small enough to always stay in memory.',
          async run() {
            const flights = grid.map((row, g) => {
              const from = center(row[0])
              const m = marks[g]
              m.path = (p) => {
                const u = 1 - p
                return [from[0], 0.6 * Math.sin(Math.PI * p) + from[1] * u, from[2] * u + MARK_Z * p]
              }
              m.p = 0
              m.a = 1
              return tw.to(m, { p: 1 }, { duration: 700, delay: g * 45, ease: 'inOutCubic' })
            })
            await all(
              ...flights,
              ...links.map((l, g) => tw.to(l, { o: 0.4 }, { duration: 400, delay: 300 + g * 45 })),
              ...markLabels.map((l, g) => tw.to(l, { o: g % 4 === 0 ? 1 : 0 }, { duration: 400, delay: 400 + g * 45 })),
              tw.to(idxTitle, { o: 1 }, { duration: 500 }),
            )
            marks.forEach((m) => {
              m.path = undefined
              m.z = MARK_Z
              m.y = 0
            })
            ctx.stats([
              { label: 'Rows', value: G * 8192 },
              { label: 'Index entries', value: G, tone: 'volt' },
              { label: 'Rows per entry', value: 8192, tone: 'cyan' },
            ])
          },
        },
        {
          title: 'A binary search over the marks',
          body: 'To find a time range, ClickHouse compares the query bounds with the marks and throws away whole halves at a time: no row data is touched yet.',
          code: "SELECT user_id FROM events\nWHERE ts BETWEEN '10:40' AND '11:05'",
          hold: 1800,
          async run() {
            await fit(ctx, { x0: -4.4, x1: 4.4, z0: -1.4, z1: 3.1 }, { theta: 0.04, phi: 0.8, duration: 900 })
            const mid = 12
            await probe(mid, `${hhmm(keyAt(mid))} &lt; 10:40 → skip left`, range(0, mid - 1), 'coral')
            await probe(last + 1, `${hhmm(keyAt(last + 1))} &gt; 11:05 → skip right`, range(last + 1, G - 1), 'coral')
            await probe(mid + 1, `next mark ${hhmm(keyAt(mid + 2))} ≤ 10:40 → skip`, range(mid, first - 1), 'coral')
            await probe(first, `${hhmm(keyAt(first))}–${hhmm(keyAt(first + 1))} overlaps → keep`, [], 'volt')
            await all(
              ...range(first, last).map((g) => tw.to(marks[g], { glow: 0.35 }, { duration: 400 })),
              ...range(first, last).map((g) => tw.to(markLabels[g], { o: 1 }, { duration: 400 })),
            )
            ctx.stats([
              { label: 'Mark range', value: `${first}–${last}`, tone: 'volt' },
              { label: 'Granules selected', value: last - first + 1, of: G, tone: 'volt', meter: (last - first + 1) / G },
            ])
          },
        },
        {
          title: 'Only the selected granules are read',
          code: 'EXPLAIN indexes = 1 …\n  PrimaryKey  Condition: (ts in [10:40, 11:05])\n              Granules: 4/24',
          body: 'The <code>.mrk</code> files translate mark numbers into byte offsets, so ClickHouse seeks straight to those granules in <code>ts.bin</code> and <code>user_id.bin</code>. <code>url.bin</code> is never opened.',
          hold: 2600,
          async run() {
            const sel = range(first, last)
            const readCells = sel.flatMap((g) => grid[g].slice(0, 2))
            await all(
              fade(ctx, grid.map((r) => r[2]), 0.06, { duration: 500 }),
              tw.to(colLabels[2], { o: 0.3 }, { duration: 500 }),
              tw.to(readCells, { glow: 0.55, y: 0.08 }, { duration: 500, delay: tw.stagger(40) }),
              fit(ctx, { x0: -4.4, x1: 5.6, z0: -2.2, z1: 3.1 }, { theta: -0.08, phi: 0.86, duration: 1200 }),
            )
            await stream(ctx, readCells.map(center), readAt, { lift: 1, duration: 800, each: 40, size: 0.12 })
            ctx.stats([
              { label: 'Granules read', value: sel.length, of: G, tone: 'volt', meter: sel.length / G },
              { label: 'Rows read', value: sel.length * 8192, tone: 'cyan' },
              { label: 'Columns opened', value: 2, of: 3 },
            ])
          },
        },
        {
          title: 'Filters on other columns can’t use it',
          body: 'The marks only know <code>ts</code>. For <code>WHERE user_id = 42</code> every granule might match, so all of them are read. Fix it with a better sort key, a projection, or a data-skipping index.',
          code: 'SELECT count() FROM events WHERE user_id = 42',
          hold: 3200,
          async run() {
            await all(
              tint(ctx, marks, P.coral, { a: 0.6, glow: 0, duration: 500 }),
              ...markLabels.map((l) => tw.to(l, { o: 0 }, { duration: 300 })),
              ...links.map((l) => tw.to(l, { o: 0.15 }, { duration: 400 })),
              tw.to(cells, { glow: 0, y: 0 }, { duration: 400 }),
            )
            const userCol = grid.map((r) => r[1])
            await all(
              tint(ctx, grid.map((r) => r[0]), P.slate, { a: 0.12, duration: 500 }),
              tint(ctx, userCol, (c) => mix(COLUMN_HUES[2], P.white, ((c.data.g * 7919) % 13) / 30), { a: 1, duration: 500 }),
            )
            await tw.to(userCol, { glow: 0.5, y: 0.08 }, { duration: 300, delay: tw.stagger(45) })
            ctx.stats([
              { label: 'Granules read', value: G, of: G, tone: 'coral', meter: 1 },
              { label: 'Rows read', value: G * 8192, tone: 'coral' },
            ])
          },
        },
        {
          title: 'At scale: 3 of 3,609 granules',
          body: 'The docs example has ~29.6M UK property sales sorted by <code>(town, street)</code>. A lookup for one street selects <b>3 of 3,609 granules</b>, reading 24,580 rows in 10 ms. The whole index is 3,609 entries.',
          code: "SELECT max(price) FROM uk_price_paid\nWHERE town = 'LONDON' AND street = 'OXFORD STREET'",
          hold: 4200,
          async run() {
            await all(
              tint(ctx, marks, (c) => keyColor(c.data.g / (G - 1)), { a: 1, glow: 0, duration: 500 }),
              tint(ctx, cells, P.slate, { a: 0.08, glow: 0, duration: 600 }),
            )
            const sel = [14, 15, 16]
            await all(
              ...sel.map((g) => tw.to(grid[g], { a: 1, glow: 0.3, y: 0.08 }, { duration: 500 })),
              ...sel.map((g) => tint(ctx, grid[g], (c) => (c.data.c === 0 ? keyColor(g / (G - 1)) : c.data.c === 1 ? mix(COLUMN_HUES[2], P.white, 0.2) : scale(COLUMN_HUES[1], 0.6)), { duration: 500 })),
              ...sel.map((g) => tw.to(marks[g], { glow: 0.3, y: 0.2 }, { duration: 400 })),
            )
            ctx.stats([
              { label: 'Granules read', value: 3, of: 3609, tone: 'volt', meter: 3 / 3609 },
              { label: 'Rows read', value: 24580, of: '29.56M', tone: 'cyan' },
              { label: 'Elapsed', value: 10, unit: ' ms' },
            ])
          },
        },
      ],
    }
  },
}
