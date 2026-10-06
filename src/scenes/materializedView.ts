import type { Cell } from '../engine/Cells'
import { COLUMN_HUES, P, mix } from '../engine/palette'
import { all, drop, fade, fit, fitRig, rng, setCamera, spawn, tint } from './kit'
import type { SceneDef } from './types'

const PAGES = ['/home', '/pricing', '/docs', '/blog']
const PC = [COLUMN_HUES[0], COLUMN_HUES[4], COLUMN_HUES[1], COLUMN_HUES[3]]
const SRC_X = -4.6
const GATE_X = 0
const DST_X = 3.7
const BATCH = 24
const BW = 8
const FULL = { x0: -6.2, x1: 6.2, z0: -3.6, z1: 1.8 }
const partZ = (k: number) => -2.3 + k * 1.4

export const materializedView: SceneDef = {
  id: 'materialized-view',
  title: 'Incremental materialized views',
  docs: 'https://clickhouse.com/docs/concepts/features/materialized-views/incremental-materialized-view',
  kicker: 'An insert trigger, not a cache',
  blurb: 'Every insert block is transformed on the fly and written to a much smaller table.',
  create(ctx) {
    const { world, tw, cells } = ctx
    const rand = rng(21)

    world.rect(SRC_X, 0.005, -0.8, BW * 0.27 + 0.8, 4.6, P.steel, 0.5, true)
    world.rect(DST_X + 0.63, 0.005, -0.8, 2.6, 4.6, P.steel, 0.5, true)
    const srcTitle = world.label('<span class="k">MergeTree</span>events', SRC_X, 0.02, -3.5, 'tag', 0)
    const dstTitle = world.label('<span class="k">SummingMergeTree</span>daily_stats', DST_X + 0.63, 0.02, -3.5, 'tag', 0)
    const gate = world.box(GATE_X, 0, -0.8, 0.25, 1.8, 4.4, P.violet, 0)
    const gateCore = cells.alloc({ x: GATE_X, y: 0, z: -0.8, w: 0.06, h: 1.8, d: 4.4, a: 0, glow: 0.3, color: P.violet })
    const gateTitle = world.label('<span class="k">MATERIALIZED VIEW</span>daily_mv', GATE_X, 2.2, -3.2, 'tag violet', 0)
    const pageLabels = PAGES.map((p, i) => world.label(p, DST_X + i * 0.42, 0.02, 1.75, 'col', 0))
    pageLabels.forEach((l) => (l.el.innerHTML = `<span>${l.el.innerHTML}</span>`))

    const srcParts: Cell[][] = []
    const dstParts: Cell[][] = []
    const totals = [0, 0, 0, 0]
    let srcRows = 0

    const makeBatch = (k: number) => {
      const batch = Array.from({ length: BATCH }, (_, i) => {
        const page = Math.min(3, Math.floor(Math.pow(rand(), 1.4) * 4))
        return spawn(ctx, {
          x: SRC_X + ((i % BW) - (BW - 1) / 2) * 0.27,
          z: partZ(k) + (Math.floor(i / BW) - 1) * 0.3,
          w: 0.21,
          d: 0.22,
          h: 0.15,
          color: PC[page],
          data: { page },
        })
      })
      // sorted by page inside the part, like ORDER BY (page, ts)
      batch
        .slice()
        .sort((a, b) => a.data.page - b.data.page)
        .forEach((c, i) => {
          c.data.home.x = SRC_X + ((i % BW) - (BW - 1) / 2) * 0.27
          c.data.home.z = partZ(k) + (Math.floor(i / BW) - 1) * 0.3
          c.x = c.data.home.x
          c.z = c.data.home.z
        })
      return batch
    }

    /** INSERT: the block lands in events and, at the same time, flows through the MV into daily_stats. */
    const insert = async (k: number) => {
      const batch = makeBatch(k)
      srcParts.push(batch)
      srcRows += BATCH
      await drop(ctx, batch, { each: 10, duration: 700 })
      const counts = [0, 0, 0, 0]
      batch.forEach((c) => counts[c.data.page]++)
      counts.forEach((n, i) => (totals[i] += n))

      // copies of the block travel to the view
      const copies = batch.map((c) => cells.alloc({ x: c.x, y: c.y, z: c.z, w: c.w, h: c.h, d: c.d, r: c.r, g: c.g, b: c.b, a: 1, glow: 0.4, data: { page: c.data.page } }))
      const aggZ = (p: number) => partZ(k) + (p - 1.5) * 0.36
      await all(
        tw.to(gateCore, { glow: 1.2 }, { duration: 500, delay: 500 }),
        ...copies.map((c, i) =>
          tw
            .to(c, { y: 0.6, x: GATE_X - 0.6, z: aggZ(c.data.page) }, { duration: 1000, delay: i * 18, ease: 'inOutCubic' })
            .then(() => tw.to(c, { x: GATE_X, w: 0.05, a: 0 }, { duration: 300, ease: 'inQuad' })),
        ),
      )
      cells.release(copies)
      // aggregated rows emerge on the other side
      const agg = counts.map((n, p) =>
        cells.alloc({ x: GATE_X + 0.2, y: 0.6, z: aggZ(p), w: 0.32, d: 0.32, h: 0.05, a: 1, glow: 0.6, color: PC[p], data: { page: p, n } }),
      )
      dstParts.push(agg)
      await all(
        tw.to(gateCore, { glow: 0.3 }, { duration: 600 }),
        tw.to(agg, { h: (c: Cell) => 0.08 + c.data.n * 0.06 }, { duration: 400 }),
        tw.to(agg, { x: (c: Cell) => DST_X + c.data.page * 0.42, z: partZ(k), y: 0, glow: 0 }, { duration: 1100, delay: tw.stagger(60), ease: 'inOutCubic' }),
      )
    }

    const stats = () =>
      ctx.stats([
        { label: 'Rows in events', value: srcRows },
        { label: 'Rows in daily_stats', value: dstParts.flat().length, tone: 'volt' },
      ])

    setCamera(ctx, fitRig(ctx, FULL, { theta: -0.2, phi: 0.92 }))

    return {
      steps: [
        {
          title: 'Two tables and a trigger',
          body: 'A materialized view is an <b>insert trigger</b>: it runs its <code>SELECT</code> on every block inserted into the source table and writes the result into a target table.',
          code: 'CREATE MATERIALIZED VIEW daily_mv TO daily_stats AS\nSELECT page, count() AS views FROM events GROUP BY page',
          async run() {
            await all(
              tw.to([srcTitle, dstTitle], { o: 1 }, { duration: 500, delay: tw.stagger(150) }),
              tw.to(gate, { o: 0.7 }, { duration: 800 }),
              tw.to(gateCore, { a: 0.35 }, { duration: 800 }),
              tw.to(gateTitle, { o: 1 }, { duration: 600, delay: 300 }),
              tw.to(pageLabels, { o: 1 }, { duration: 600, delay: tw.stagger(80) }),
              fit(ctx, FULL, { theta: -0.1, phi: 0.9, duration: 2000 }),
            )
          },
        },
        {
          title: 'An INSERT into events…',
          body: 'A batch of 24 page views arrives and is written as a new part of <code>events</code>, exactly as without the view.',
          async run() {
            const batch = makeBatch(0)
            srcParts.push(batch)
            srcRows += BATCH
            await drop(ctx, batch, { each: 12, duration: 800 })
            stats()
          },
        },
        {
          title: '…runs the view on that block only',
          body: 'The same block flows through the view’s <code>GROUP BY</code>. 24 rows become 4, one per page, and land as a small part in <code>daily_stats</code>. The view never re-reads old data.',
          async run() {
            const batch = srcParts[0]
            const counts = [0, 0, 0, 0]
            batch.forEach((c) => counts[c.data.page]++)
            counts.forEach((n, i) => (totals[i] += n))
            const copies = batch.map((c) => cells.alloc({ x: c.x, y: c.y, z: c.z, w: c.w, h: c.h, d: c.d, r: c.r, g: c.g, b: c.b, a: 1, glow: 0.4, data: { page: c.data.page } }))
            const aggZ = (p: number) => partZ(0) + (p - 1.5) * 0.36
            await all(
              tw.to(gateCore, { glow: 1.2 }, { duration: 500, delay: 700 }),
              ...copies.map((c, i) =>
                tw
                  .to(c, { y: 0.6, x: GATE_X - 0.6, z: aggZ(c.data.page) }, { duration: 1400, delay: i * 30, ease: 'inOutCubic' })
                  .then(() => tw.to(c, { x: GATE_X, w: 0.05, a: 0 }, { duration: 350, ease: 'inQuad' })),
              ),
            )
            cells.release(copies)
            const agg = counts.map((n, p) =>
              cells.alloc({ x: GATE_X + 0.2, y: 0.6, z: aggZ(p), w: 0.32, d: 0.32, h: 0.05, a: 1, glow: 0.6, color: PC[p], data: { page: p, n } }),
            )
            dstParts.push(agg)
            await all(
              tw.to(gateCore, { glow: 0.3 }, { duration: 600 }),
              tw.to(agg, { h: (c: Cell) => 0.08 + c.data.n * 0.06 }, { duration: 500 }),
              tw.to(agg, { x: (c: Cell) => DST_X + c.data.page * 0.42, z: partZ(0), y: 0, glow: 0 }, { duration: 1300, delay: tw.stagger(80), ease: 'inOutCubic' }),
            )
            stats()
          },
        },
        {
          title: 'Every insert repeats this',
          body: 'Each insert adds one part to <code>events</code> and one tiny part to <code>daily_stats</code>. Rows for the same page now exist several times in the target.',
          async run() {
            await insert(1)
            stats()
            await insert(2)
            stats()
          },
        },
        {
          title: 'Merges finish the aggregation',
          body: '<code>SummingMergeTree</code> adds up rows with the same key whenever it merges parts. Twelve rows collapse into four, in the background.',
          async run() {
            const byPage = [0, 1, 2, 3].map((p) => dstParts.flat().filter((c) => c.data.page === p))
            const keep = byPage.map((l) => l[0])
            const rest = byPage.flatMap((l) => l.slice(1))
            await tw.to(dstParts.flat(), { y: 0.5, glow: 0.4 }, { duration: 400, delay: tw.stagger(25) })
            await all(...rest.map((c) => tw.to(c, { x: DST_X + c.data.page * 0.42, z: partZ(1), w: 0.2, d: 0.2 }, { duration: 900, ease: 'inOutCubic' })), tw.to(keep, { z: partZ(1) }, { duration: 900, ease: 'inOutCubic' }))
            await all(
              fade(ctx, rest, 0, { duration: 300 }),
              tw.to(keep, { h: (c: Cell) => 0.08 + totals[c.data.page] * 0.035, y: 0, glow: 0.2 }, { duration: 700, ease: 'outBack' }),
            )
            cells.release(rest)
            dstParts.length = 0
            dstParts.push(keep)
            stats()
          },
        },
        {
          title: 'Queries read the small table',
          body: 'Dashboards query <code>daily_stats</code>: 4 rows instead of 72. Keep <code>sum()</code> in the query, since merges are eventual and duplicates may not be folded yet.',
          code: 'SELECT page, sum(views) FROM daily_stats GROUP BY page',
          hold: 3400,
          async run() {
            const src = srcParts.flat()
            const dst = dstParts.flat()
            await all(
              tint(ctx, src, (c) => mix(P.slate, [c.r, c.g, c.b], 0.25), { a: 0.12, duration: 700 }),
              tw.to(dst, { glow: 0.8 }, { duration: 500, delay: tw.stagger(80) }),
              fit(ctx, { x0: -1.5, x1: 6.5, z0: -3.6, z1: 2 }, { theta: -0.3, phi: 0.9, duration: 1500 }),
            )
            await tw.to(dst, { glow: 0.35 }, { duration: 500 })
            ctx.stats([
              { label: 'Rows read · events', value: srcRows, tone: 'coral' },
              { label: 'Rows read · daily_stats', value: dst.length, tone: 'volt' },
            ])
          },
        },
      ],
    }
  },
}
