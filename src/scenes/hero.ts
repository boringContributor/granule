import type { Cell } from '../engine/Cells'
import { P, keyColor, mix, scale } from '../engine/palette'
import { all, center, drop, fade, fit, fitRig, pulse, rng, setCamera, spawn, stream, tint } from './kit'
import type { SceneDef } from './types'

const COLS = 4
const TINY_G = 2
const GRID_X = 10
const GRID_Z = 5
const CPX = 0.3
const GPZ = 0.26
const COL_DIM = [1, 0.8, 0.68, 0.58]
const LO = 0.44
const HI = 0.5
const READ_COLS = [0, 2]

/**
 * The 15-second pitch: fifty tiny parts land, collapse into five sorted parts,
 * and a query lights up the ~10% of granules it actually needs.
 */
export const hero: SceneDef = {
  id: 'overview',
  docs: 'https://clickhouse.com/docs/concepts/core-concepts/index',
  title: 'Overview',
  kicker: '15 seconds of ClickHouse',
  blurb: 'Fifty inserts, five merges, one query that skips 90% of the data.',
  create(ctx) {
    const { world, tw } = ctx
    const rand = rng(7)

    interface Row {
      key: number
      cells: Cell[]
    }
    // 50 tiny parts, each holding 2 granules (rows of the drawing) of 4 columns
    const tiny: Row[][] = []
    for (let p = 0; p < GRID_X * GRID_Z; p++) {
      const px = (p % GRID_X - (GRID_X - 1) / 2) * 1.55
      const pz = (Math.floor(p / GRID_X) - (GRID_Z - 1) / 2) * 0.95
      const keys = [rand(), rand()].sort((a, b) => a - b)
      tiny.push(
        keys.map((key, g) => ({
          key,
          cells: Array.from({ length: COLS }, (_, c) =>
            spawn(ctx, {
              x: px + (c - (COLS - 1) / 2) * CPX,
              z: pz + (g - (TINY_G - 1) / 2) * GPZ,
              w: 0.24,
              d: 0.2,
              h: 0.16,
              color: scale(keyColor(key), COL_DIM[c]),
              data: { col: c, part: p },
            }),
          ),
        })),
      )
    }
    const allCells = tiny.flatMap((p) => p.flatMap((r) => r.cells))

    // five merged parts: the rows of each grid line, merge-sorted by key
    const merged: Row[][] = Array.from({ length: GRID_Z }, (_, m) =>
      tiny.slice(m * GRID_X, (m + 1) * GRID_X).flat().sort((a, b) => a.key - b.key),
    )
    const mergedPos = (m: number, g: number, c: number) => ({
      x: (m - (GRID_Z - 1) / 2) * 2.5 + (c - (COLS - 1) / 2) * CPX,
      z: (g - (merged[m].length - 1) / 2) * GPZ,
    })

    // granule ranges: granule g of a sorted part covers [key_g, key_{g+1})
    const selected = new Set<Row>()
    for (const part of merged) {
      let first = 0
      let last = 0
      part.forEach((r, g) => {
        if (r.key <= LO) first = g
        if (r.key <= HI) last = g
      })
      for (let g = first; g <= last; g++) selected.add(part[g])
    }
    const totalGranules = merged.reduce((s, p) => s + p.length, 0)

    const resultAt: [number, number, number] = [0, 1.5, 4.8]
    const result = world.label('<span class="k">result</span> 1 row', resultAt[0], resultAt[1] + 0.75, resultAt[2], 'tag volt')
    const resultCell = ctx.cells.alloc({ x: resultAt[0], y: resultAt[1] - 0.2, z: resultAt[2], w: 0.36, h: 0.36, d: 0.36, a: 0, glow: 0.2, color: P.volt })
    const sweep = ctx.cells.alloc({ x: 0, y: 0.25, z: -3.2, w: 13.6, h: 0.02, d: 0.05, a: 0, glow: 0.9, color: P.volt })

    setCamera(ctx, fitRig(ctx, { x0: -8, x1: 8, z0: -2.4, z1: 2.4 }, { theta: -0.42, phi: 0.92, pad: 1.0 }))

    return {
      loop: true,
      steps: [
        {
          title: 'Every INSERT creates a part',
          body: 'Fifty small inserts land as fifty immutable <b>parts</b>, each sorted by the table’s <code>ORDER BY</code> key.',
          hold: 300,
          async run() {
            ctx.stats([
              { label: 'Active parts', value: 50, tone: 'volt' },
              { label: 'Granules', value: 100 },
            ])
            await all(
              fit(ctx, { x0: -7.6, x1: 7.6, z0: -2.4, z1: 2.4 }, { theta: -0.34, phi: 0.92, pad: 1.0, duration: 2600 }),
              ...tiny.map((p, i) => tw.wait(i * 34).then(() => drop(ctx, p.flatMap((r) => r.cells), { from: 3.2, duration: 750, each: 4 }))),
            )
          },
        },
        {
          title: 'Background merges combine them',
          body: 'ClickHouse continuously <b>merge-sorts</b> small parts into bigger ones. Same rows, far fewer files, one long sorted run.',
          hold: 200,
          async run() {
            const moves: Promise<void>[] = []
            merged.forEach((part, m) => {
              part.forEach((row, g) => {
                row.cells.forEach((c) => {
                  const t = mergedPos(m, g, c.data.col)
                  const delay = m * 140 + g * 14
                  moves.push(
                    tw
                      .to(c, { y: 1.4 + g * 0.02 }, { duration: 420, delay, ease: 'outQuad' })
                      .then(() => tw.to(c, { x: t.x, z: t.z }, { duration: 760, ease: 'inOutCubic' }))
                      .then(() => tw.to(c, { y: 0 }, { duration: 380, ease: 'inQuad' })),
                  )
                })
              })
            })
            ctx.stats([
              { label: 'Active parts', value: 5, tone: 'volt' },
              { label: 'Granules', value: totalGranules },
            ])
            await all(fit(ctx, { x0: -6.4, x1: 6.4, z0: -2.8, z1: 3.6, y1: 2 }, { theta: -0.48, phi: 0.9, pad: 1.0, duration: 2400 }), ...moves)
          },
        },
        {
          title: 'A query skips what it doesn’t need',
          body: '<code>WHERE key BETWEEN …</code> reads only <b>2 of 4 columns</b> and the few granules whose key range matches. The rest is never touched.',
          code: 'SELECT k, sum(v) FROM t WHERE k BETWEEN 44 AND 50',
          hold: 1800,
          async run() {
            const unread = allCells.filter((c) => !READ_COLS.includes(c.data.col))
            await fade(ctx, unread, 0.1, { duration: 600 })

            // a scan line sweeps the sort order; rows outside the range go dark as it passes
            sweep.z = -3.2
            const skip = merged.flatMap((p) => p.filter((r) => !selected.has(r))).flatMap((r) => r.cells.filter((c) => READ_COLS.includes(c.data.col)))
            const keep = [...selected].flatMap((r) => r.cells.filter((c) => READ_COLS.includes(c.data.col)))
            await all(
              tw.to(sweep, { a: 1 }, { duration: 200 }),
              tw.to(sweep, { z: 3.2 }, { duration: 1300, ease: 'inOutSine' }),
              ...skip.map((c) => tw.wait(((c.z + 3.2) / 6.4) * 1300).then(() => tint(ctx, [c], mix(P.slate, [c.r, c.g, c.b], 0.25), { a: 0.09, duration: 350 }))),
              ...keep.map((c) => tw.wait(((c.z + 3.2) / 6.4) * 1300).then(() => tw.to(c, { glow: 0.5, y: 0.12 }, { duration: 350 }))),
            )
            await tw.to(sweep, { a: 0 }, { duration: 250 })

            const g = selected.size
            ctx.stats([
              { label: 'Granules read', value: g, of: totalGranules, tone: 'volt', meter: g / totalGranules },
              { label: 'Columns read', value: 2, of: 4 },
              { label: 'Data skipped', value: Math.round(100 - (g / totalGranules) * 50), unit: '%', tone: 'cyan' },
            ])
            await tw.to(resultCell, { a: 1 }, { duration: 300 })
            await stream(ctx, keep.map(center), resultAt, { lift: 1.2, duration: 800, each: 14, size: 0.11 })
            await all(tw.to(result, { o: 1 }, { duration: 400 }), pulse(ctx, [resultCell], 0.9, 0.25))
          },
        },
        {
          title: 'See what ClickHouse is actually doing',
          body: 'Pick a lesson on the left, or paste your own SQL into the <b>Query lab</b>.',
          hold: 600,
          async run() {
            await all(tw.to(result, { o: 0 }, { duration: 500 }), fade(ctx, [resultCell], 0), fade(ctx, allCells, 0, { duration: 900 }), tw.to(allCells, { glow: 0 }, { duration: 600 }))
          },
        },
      ],
    }
  },
}
