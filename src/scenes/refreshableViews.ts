import type { Cell } from '../engine/Cells'
import type { Label } from '../engine/World'
import { COLUMN_HUES, P, keyColor, mix, scale } from '../engine/palette'
import { all, center, drop, fade, fit, fitRig, packet, rng, setCamera, spawn, stream, tint } from './kit'
import type { SceneDef } from './types'

const SRC_X = -5
const VIEW_X = 0
const DST_X = 4.6
const SRC_COLS = 8
const SRC_ROWS = 6
const TOP = 6
const FULL = { x0: -7, x1: 6.6, z0: -2.4, z1: 3.4 }

const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(Math.round(min) % 60).padStart(2, '0')}`

export const refreshableViews: SceneDef = {
  id: 'refreshable-views',
  title: 'Refreshable & cascading views',
  kicker: 'Scheduled rebuilds and chains',
  blurb: 'Refreshable views re-run a full query on a schedule; cascading views chain incremental steps.',
  docs: 'https://clickhouse.com/docs/concepts/features/materialized-views/refreshable-materialized-view',
  create(ctx) {
    const { world, tw, cells } = ctx
    const rand = rng(12)

    // ---- source table ----
    const src: Cell[] = []
    for (let r = 0; r < SRC_ROWS; r++)
      for (let c = 0; c < SRC_COLS; c++)
        src.push(
          spawn(ctx, {
            x: SRC_X + (c - (SRC_COLS - 1) / 2) * 0.3,
            z: (r - (SRC_ROWS - 1) / 2) * 0.36,
            w: 0.24,
            d: 0.26,
            h: 0.14,
            color: keyColor(rand()),
          }),
        )
    const srcTitle = world.label('<span class="k">MergeTree</span>events', SRC_X, 0.02, -1.6, 'tag', 0)

    // ---- the view node ----
    const view = cells.alloc({ x: VIEW_X, y: 0, z: 0, w: 1.3, h: 0.36, d: 1.1, a: 0, color: mix(P.slate, P.violet, 0.4) })
    const viewTitle = world.label('<span class="k">MV</span>top_users', VIEW_X, 0.02, -1.0, 'tag violet', 0)
    const clock = world.label('', VIEW_X, 1.3, 0, 'tag', 0)
    const clockState = { min: 0 }
    const showClock = () => clock.set(`<span class="k">REFRESH EVERY 1 HOUR</span>${hhmm(clockState.min)}`)
    showClock()
    const tick = (to: number) => tw.to(clockState, { min: to }, { duration: 1500, ease: 'inOutSine', onUpdate: showClock })

    // ---- target table: TOP rows as bars ----
    const dstTitle = world.label('top_users', DST_X, 0.02, -1.6, 'tag', 0)
    const makeResult = (z0: number, a = 0, ghost = false) =>
      Array.from({ length: TOP }, (_, i) =>
        cells.alloc({
          x: DST_X - 0.8 + (1.6 * (TOP - i)) / TOP / 2,
          z: z0 + (i - (TOP - 1) / 2) * 0.28,
          w: (1.6 * (TOP - i)) / TOP,
          d: 0.2,
          h: 0.14,
          a,
          color: ghost ? P.steel : scale(COLUMN_HUES[i % 3], 0.9),
        }),
      )
    let target: Cell[] = makeResult(0)
    let pending: Cell[] = []
    const extras: { cells: Cell[]; labels: Label[] } = { cells: [], labels: [] }

    const insertBlock = (n: number, z: number) =>
      Array.from({ length: n }, (_, i) => spawn(ctx, { x: SRC_X + (i - (n - 1) / 2) * 0.3, z, w: 0.24, d: 0.26, h: 0.14, color: P.cyan }))

    /** Refresh: read the whole source, build a new result next to the target. */
    const refresh = async (z: number) => {
      await all(tw.to(src, { glow: 0.35 }, { duration: 300, delay: tw.stagger(4) }), tw.to(view, { glow: 0.5 }, { duration: 300 }))
      const sample = src.filter((_, i) => i % 3 === 0)
      await stream(ctx, sample.map(center), [VIEW_X, 0.3, 0], { lift: 1, duration: 650, each: 18, size: 0.1, color: P.violet })
      await all(tw.to(src, { glow: 0 }, { duration: 400 }), tw.to(view, { glow: 0.1 }, { duration: 400 }))
      const fresh = makeResult(z, 0, false)
      await all(...fresh.map((c, i) => packet(ctx, [VIEW_X, 0.3, 0], [c.x, 0.2, c.z], { lift: 0.8, duration: 600, delay: i * 60, size: 0.12, color: P.violet }).then(() => tw.to(c, { a: 1 }, { duration: 200 }))))
      return fresh
    }

    // cascade elements (step 6)
    const stageX = [-5, 0, 5]
    const stageTitles = [
      world.label('<span class="k">raw</span>events', stageX[0], 0.02, -1.7, 'tag', 0),
      world.label('<span class="k">hourly</span>events_per_hour', stageX[1], 0.02, -1.7, 'tag', 0),
      world.label('<span class="k">daily</span>events_per_day', stageX[2], 0.02, -1.7, 'tag', 0),
    ]
    const mvLabels: Label[] = [world.label('mv_hourly', -2.5, 1.1, 0, 'tag violet', 0), world.label('mv_daily', 2.5, 1.1, 0, 'tag violet', 0)]

    setCamera(ctx, fitRig(ctx, FULL, { theta: -0.08, phi: 0.84 }))

    return {
      steps: [
        {
          title: 'Incremental views only see new blocks',
          body: 'A regular materialized view runs on each <b>inserted block</b> and appends its result to the target. It never looks at the rest of the table, so it can’t easily rank, dedupe or join across all of it.',
          async run() {
            await all(
              drop(ctx, src, { each: 4, duration: 600 }),
              tw.to(view, { a: 1 }, { duration: 500 }),
              tw.to([srcTitle, viewTitle, dstTitle], { o: 1 }, { duration: 500, delay: tw.stagger(120) }),
            )
            const block = insertBlock(4, 1.5)
            await drop(ctx, block, { each: 40, duration: 600, from: 2 })
            await all(...block.map((b, i) => packet(ctx, center(b), [VIEW_X, 0.3, 0], { lift: 1, duration: 700, delay: i * 60, size: 0.1, color: P.cyan })))
            await all(...target.slice(0, 2).map((c, i) => packet(ctx, [VIEW_X, 0.3, 0], [c.x, 0.2, c.z], { lift: 0.8, duration: 600, delay: i * 80, size: 0.12, color: P.cyan }).then(() => tw.to(c, { a: 1 }, { duration: 200 }))))
            await tint(ctx, block, (c) => keyColor((c.x + 6) / 3), { duration: 400 })
            src.push(...block)
          },
        },
        {
          title: 'Refreshable views re-run the whole query',
          body: 'A <b>refreshable</b> view runs its full query on a schedule, here once an hour, over all of <code>events</code>. Use it for top-N lists, joins and anything that needs the whole dataset.',
          code: 'CREATE MATERIALIZED VIEW top_users\nREFRESH EVERY 1 HOUR TO top_users_tbl AS\nSELECT user_id, count() AS c FROM events\nGROUP BY user_id ORDER BY c DESC LIMIT 6',
          async run() {
            await tw.to(clock, { o: 1 }, { duration: 300 })
            await tick(60)
            pending = await refresh(2.1)
            ctx.stats([
              { label: 'Rows read per refresh', value: 'all', tone: 'violet' },
              { label: 'Refreshes', value: 1 },
            ])
          },
        },
        {
          title: 'The target is swapped atomically',
          body: 'The new result is built on the side and then exchanged with the old one in a single step. Readers see the previous result or the new one, never a half-written mix.',
          async run() {
            const fresh = pending
            const old = target
            await all(
              tint(ctx, old, P.steel, { a: 0.25, duration: 400 }),
              tw.to(old, { z: (c: Cell) => c.z - 2.1 }, { duration: 900, ease: 'inOutCubic' }),
              tw.to(fresh, { z: (c: Cell) => c.z - 2.1 }, { duration: 900, ease: 'inOutCubic' }),
            )
            await fade(ctx, old, 0, { duration: 400 })
            cells.release(old)
            target = fresh
            await tw.to(target, { glow: 0.3 }, { duration: 200 }).then(() => tw.to(target, { glow: 0 }, { duration: 500 }))
          },
        },
        {
          title: 'APPEND keeps every refresh',
          body: 'With <code>APPEND</code>, each refresh adds its result as new rows instead of replacing the table. That’s how you build periodic snapshots and history.',
          code: 'REFRESH EVERY 1 HOUR APPEND TO top_users_history',
          async run() {
            await tick(120)
            const snap = await refresh(2.1)
            await all(tw.to(target, { z: (c: Cell) => c.z - 0.9, d: 0.12 }, { duration: 700 }), tw.to(snap, { z: (c: Cell) => c.z - 1.2, d: 0.12 }, { duration: 700 }))
            target = [...target, ...snap]
            dstTitle.set('<span class="k">APPEND</span>top_users_history')
            ctx.stats([
              { label: 'Refreshes', value: 2 },
              { label: 'Snapshots kept', value: 2, tone: 'cyan' },
            ])
          },
        },
        {
          title: 'Refreshes can wait for each other',
          body: 'A refreshable view can <code>DEPENDS ON</code> another one. When both are due, ClickHouse runs them in order, so the downstream view always reads a finished upstream result.',
          code: 'CREATE MATERIALIZED VIEW user_tiers\nREFRESH EVERY 1 HOUR DEPENDS ON top_users …',
          async run() {
            const depX = DST_X
            const dep = cells.alloc({ x: depX, y: 0, z: 2.6, w: 1.3, h: 0.36, d: 0.9, a: 0, color: mix(P.slate, P.violet, 0.4) })
            const depTitle = world.label('<span class="k">MV · DEPENDS ON top_users</span>user_tiers', depX, 0.02, 3.35, 'tag violet', 0)
            extras.cells.push(dep)
            extras.labels.push(depTitle)
            await all(tw.to(dep, { a: 1 }, { duration: 400 }), tw.to(depTitle, { o: 1 }, { duration: 400 }))
            await tick(180)
            const order1 = world.label('1', VIEW_X + 0.95, 0.5, 0, 'tag volt', 0)
            const order2 = world.label('2', depX + 0.95, 0.5, 2.6, 'tag volt', 0)
            extras.labels.push(order1, order2)
            await all(tw.to(view, { glow: 0.5 }, { duration: 300 }), tw.to(order1, { o: 1 }, { duration: 300 }))
            await stream(ctx, src.filter((_, i) => i % 6 === 0).map(center), [VIEW_X, 0.3, 0], { lift: 1, duration: 500, each: 25, size: 0.1, color: P.violet })
            await tw.to(view, { glow: 0.1 }, { duration: 300 })
            await all(tw.to(dep, { glow: 0.5 }, { duration: 300 }), tw.to(order2, { o: 1 }, { duration: 300 }))
            await stream(ctx, target.slice(-TOP).map(center), [depX, 0.3, 2.6], { lift: 0.6, duration: 500, each: 50, size: 0.1, color: P.violet })
            await tw.to(dep, { glow: 0.1 }, { duration: 300 })
          },
        },
        {
          title: 'Cascading incremental views',
          body: 'Incremental views can also chain: one view’s target table is the next view’s source. Each insert flows <b>raw → hourly → daily</b>, getting smaller at every step.',
          code: 'mv_hourly: events → events_per_hour\nmv_daily:  events_per_hour → events_per_day',
          hold: 3800,
          async run() {
            // clear the refreshable picture
            await all(
              fade(ctx, [...src, ...target, view, ...extras.cells], 0, { duration: 500 }),
              tw.to([srcTitle, viewTitle, dstTitle, clock, ...extras.labels], { o: 0 }, { duration: 400 }),
            )
            await all(
              tw.to(stageTitles, { o: 1 }, { duration: 500, delay: tw.stagger(150) }),
              tw.to(mvLabels, { o: 1 }, { duration: 500, delay: tw.stagger(150) }),
              fit(ctx, { x0: -6.6, x1: 6.6, z0: -2.2, z1: 2 }, { theta: -0.06, phi: 0.84, duration: 900 }),
            )
            const raw = Array.from({ length: 24 }, (_, i) =>
              spawn(ctx, { x: stageX[0] + ((i % 8) - 3.5) * 0.3, z: (Math.floor(i / 8) - 1) * 0.36, w: 0.24, d: 0.26, h: 0.14, color: scale(COLUMN_HUES[Math.floor(i / 4) % 6], 0.9), data: { h: Math.floor(i / 4) } }),
            )
            await drop(ctx, raw, { each: 15, duration: 600 })
            // raw → hourly: 24 rows become 6 (one per hour)
            const hourly = Array.from({ length: 6 }, (_, h) =>
              cells.alloc({ x: stageX[1] + (h - 2.5) * 0.42, z: 0, w: 0.34, d: 0.34, h: 0.05, a: 0, color: scale(COLUMN_HUES[h], 0.9), data: { h } }),
            )
            await all(...raw.map((c, i) => packet(ctx, center(c), [stageX[1] + (c.data.h - 2.5) * 0.42, 0.3, 0], { lift: 1.2, duration: 800, delay: i * 30, size: 0.09, color: [c.r, c.g, c.b] })))
            await tw.to(hourly, { a: 1, h: 0.4 }, { duration: 500, ease: 'outBack' })
            // hourly → daily: 6 rows become 1
            const daily = cells.alloc({ x: stageX[2], z: 0, w: 0.55, d: 0.55, h: 0.05, a: 0, color: P.cyan })
            await all(...hourly.map((c, i) => packet(ctx, center(c), [stageX[2], 0.3, 0], { lift: 1.2, duration: 800, delay: i * 60, size: 0.11, color: [c.r, c.g, c.b] })))
            await tw.to(daily, { a: 1, h: 0.8, glow: 0.12 }, { duration: 600, ease: 'outBack' })
            ctx.stats([
              { label: 'raw rows', value: 24 },
              { label: 'hourly rows', value: 6, tone: 'cyan' },
              { label: 'daily rows', value: 1, tone: 'volt' },
            ])
          },
        },
      ],
    }
  },
}
