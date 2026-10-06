import type { Cell } from '../engine/Cells'
import type { Label, LineHandle } from '../engine/World'
import { COLUMN_HUES, P, keyColor, mix } from '../engine/palette'
import { all, center, fade, fit, fitRig, packet, pulse, rng, setCamera, spawn, tint, type V3 } from './kit'
import type { SceneDef } from './types'

const LANES = 4
const STORE_X = -7.4
const STORE_COLS = 4
const STORE_ROWS = 12
const STAGE_X = [-3.7, -0.4, 2.6]
const RESIZE_X = -2.05
const MERGE_X = 5.4
const RESULT_X = 7.4
const STAGES = [
  ['Read', 'MergeTreeSelect'],
  ['Filter', 'ExpressionTransform'],
  ['Aggregate', 'AggregatingTransform'],
]
const laneZ = (l: number) => (l - (LANES - 1) / 2) * 1.5
const LANE_COLORS = [COLUMN_HUES[0], COLUMN_HUES[1], COLUMN_HUES[2], COLUMN_HUES[3]]
const FULL = { x0: -8.6, x1: 8.4, z0: -3.6, z1: 3 }

export const queryParallelism: SceneDef = {
  id: 'query-parallelism',
  title: 'Query parallelism',
  kicker: 'Granules fan out over lanes',
  blurb: 'Selected granules are streamed through max_threads parallel processing lanes and merged into one result.',
  docs: 'https://clickhouse.com/docs/concepts/core-concepts/query-parallelism',
  create(ctx) {
    const { world, tw, cells } = ctx
    const rand = rng(31)

    // the granules of a table, and the ones the primary index selects
    const store: Cell[] = []
    for (let r = 0; r < STORE_ROWS; r++)
      for (let c = 0; c < STORE_COLS; c++)
        store.push(spawn(ctx, { x: STORE_X + (c - 1.5) * 0.42, z: (r - (STORE_ROWS - 1) / 2) * 0.42, w: 0.34, d: 0.32, h: 0.14, color: keyColor(r / (STORE_ROWS - 1)), data: { r, c } }))
    const selected = store.filter(() => rand() < 0.7)
    const skipped = store.filter((c) => !selected.includes(c))
    const storeLabel = world.label('selected granules', STORE_X, 0.02, (STORE_ROWS / 2) * 0.42 + 0.35, 'small', 0)

    // processing lanes: three stages each, plus a Resize column between read and filter
    const slabs: Cell[][] = Array.from({ length: LANES }, (_, l) =>
      STAGE_X.map((x) => cells.alloc({ x, y: 0, z: laneZ(l), w: 2.2, h: 0.08, d: 0.72, a: 0, color: P.slate })),
    )
    const tracks: LineHandle[] = Array.from({ length: LANES }, (_, l) =>
      world.polyline(
        [
          [STAGE_X[0] - 1.3, 0.05, laneZ(l)],
          [STAGE_X[2] + 1.2, 0.05, laneZ(l)],
        ],
        P.steel,
        0,
        true,
      ),
    )
    const laneLabels: Label[] = Array.from({ length: LANES }, (_, l) => world.label(`lane ${l + 1}`, STAGE_X[0] - 1.75, 0.02, laneZ(l), 'small', 0))
    const stageLabels = STAGES.map(([a, b], i) => world.label(`${a}<small>${b}</small>`, STAGE_X[i], 0.02, laneZ(0) - 0.95, 'title', 0))
    const resizeBar = cells.alloc({ x: RESIZE_X, y: 0, z: 0, w: 0.08, h: 0.5, d: (LANES - 1) * 1.5 + 0.8, a: 0, glow: 0.2, color: P.violet })
    const resizeLabel = world.label('Resize', RESIZE_X, 0.9, laneZ(LANES - 1) + 0.75, 'tag violet', 0)
    const states: Cell[] = Array.from({ length: LANES }, (_, l) =>
      cells.alloc({ x: STAGE_X[2] + 0.55, y: 0.08, z: laneZ(l), w: 0.4, h: 0.02, d: 0.4, a: 0, color: LANE_COLORS[l] }),
    )
    const mergeNode = cells.alloc({ x: MERGE_X, y: 0, z: 0, w: 0.9, h: 0.2, d: 1.6, a: 0, color: P.slate })
    const mergeLabel = world.label('merge', MERGE_X, 0.02, 1.15, 'small', 0)
    const result = cells.alloc({ x: RESULT_X, y: 0, z: 0, w: 0.5, h: 0.02, d: 0.5, a: 0, glow: 0.1, color: P.volt })
    const resultLabel = world.label('result', RESULT_X, 0.02, 0.6, 'tag volt', 0)
    const processed = Array(LANES).fill(0)

    const hop = (from: V3, to: V3, color: [number, number, number], duration: number, lift = 0.25, delay = 0) =>
      packet(ctx, from, to, { color, lift, duration, delay, size: 0.17, glow: 0.45 })

    /**
     * Stream granules through the lanes. Each lane pulls the next granule when it is free.
     * A slow lane hands its blocks to the other lanes at the Resize column.
     */
    const run = async (queue: Cell[], opts: { lanes?: number; slowLane?: number; speed?: number } = {}) => {
      const lanes = opts.lanes ?? LANES
      const sp = opts.speed ?? 1
      let rr = 0
      const worker = async (l: number) => {
        while (queue.length) {
          const g = queue.shift()!
          const z = laneZ(l)
          const color = mix(LANE_COLORS[l], [g.r, g.g, g.b], 0.35)
          await tint(ctx, [g], (c) => mix(P.slate, [c.r, c.g, c.b], 0.3), { a: 0.18, duration: 200 })
          await hop(center(g), [STAGE_X[0], 0.3, z], color, 650 * sp, 1)
          let lane = l
          if (opts.slowLane === l) {
            // stuck in a slow read: Resize hands the block on to the other lanes
            const others = Array.from({ length: lanes }, (_, i) => i).filter((i) => i !== l)
            lane = others[rr++ % others.length]
            await tw.wait(500 * sp)
          }
          const zz = laneZ(lane)
          await hop([STAGE_X[0], 0.3, z], [RESIZE_X, 0.3, zz], color, 300 * sp, 0.15)
          await hop([RESIZE_X, 0.3, zz], [STAGE_X[1], 0.3, zz], color, 300 * sp, 0.15)
          // the filter drops some rows: about a third of blocks end here
          if (g.data.r % 3 === 1) continue
          await hop([STAGE_X[1], 0.3, zz], [STAGE_X[2], 0.3, zz], color, 420 * sp, 0.2)
          processed[lane]++
          await tw.to(states[lane], { h: 0.06 + processed[lane] * 0.07 }, { duration: 200 })
        }
      }
      await all(...Array.from({ length: lanes }, (_, l) => tw.wait(l * 90).then(() => worker(l))))
    }

    setCamera(ctx, fitRig(ctx, FULL, { theta: -0.06, phi: 0.9 }))

    return {
      steps: [
        {
          title: 'The primary index selects granules',
          body: 'Before any data flows, ClickHouse analyzes the primary index and picks the granules that may contain matching rows. Those are the work items for the query.',
          code: 'SELECT max(price) FROM uk_price_paid WHERE town = \'LONDON\'',
          async run() {
            await all(
              tw.to(store, { a: 1, y: 0 }, { duration: 700, delay: tw.stagger(8) }),
              tw.to(storeLabel, { o: 1 }, { duration: 500 }),
            )
            await tint(ctx, skipped, (c) => mix(P.slate, [c.r, c.g, c.b], 0.25), { a: 0.1, duration: 600, each: 6 })
            ctx.stats([
              { label: 'Granules selected', value: selected.length, of: store.length, tone: 'volt', meter: selected.length / store.length },
            ])
          },
        },
        {
          title: 'Lanes pull granules dynamically',
          body: 'The selected granules are spread over <b>n parallel processing lanes</b>. <code>max_threads</code> sets n, by default the number of CPU cores (4 here). Each lane takes the next granule as soon as it is free.',
          code: 'SETTINGS max_threads = 4',
          async run() {
            await all(
              ...slabs.flat().map((s, i) => tw.to(s, { a: 1 }, { duration: 400, delay: i * 25 })),
              ...tracks.map((t) => tw.to(t, { o: 0.45 }, { duration: 400 })),
              tw.to([...laneLabels, ...stageLabels], { o: 1 }, { duration: 500, delay: tw.stagger(60) }),
              tw.to(states, { a: 1 }, { duration: 400 }),
              tw.to(resizeBar, { a: 0.35 }, { duration: 400 }),
            )
            await run(selected.slice(0, 18))
            ctx.stats([
              { label: 'Lanes', value: LANES, of: 'max_threads', tone: 'cyan' },
              { label: 'Granules done', value: 18, of: selected.length },
            ])
          },
        },
        {
          title: 'Each lane is a pipeline',
          body: 'Inside a lane, data streams block by block: <b>Read</b> the granule’s columns, <b>Filter</b> rows by the predicate, <b>Aggregate</b> into a lane-local state. All stages run at the same time across all lanes.',
          code: 'EXPLAIN PIPELINE SELECT max(price) …\n(Aggregating)       AggregatingTransform × 4\n(Filter)            ExpressionTransform × 4\n(ReadFromMergeTree) MergeTreeSelect × 4',
          hold: 2400,
          async run() {
            for (let s = 0; s < 3; s++) {
              await all(
                pulse(ctx, slabs.map((l) => l[s]), 0.5, 0, { duration: 700 }),
                tint(ctx, slabs.map((l) => l[s]), mix(P.slate, P.cyan, 0.3), { duration: 300 }),
                tw.to(stageLabels[s], { y: 0.5 }, { duration: 300 }),
              )
              await tw.wait(250)
              await all(tint(ctx, slabs.map((l) => l[s]), P.slate, { duration: 300 }), tw.to(stageLabels[s], { y: 0.02 }, { duration: 300 }))
            }
          },
        },
        {
          title: 'Resize keeps every lane busy',
          body: 'Lanes don’t run at the same speed. <b>Resize</b> operators repartition the block streams between stages, so a slow lane hands work to faster ones and all lanes finish together.',
          async run() {
            await all(tw.to(resizeBar, { a: 1, glow: 0.45 }, { duration: 400 }), tw.to(resizeLabel, { o: 1 }, { duration: 400 }))
            const slowTag = world.label('slow read', STAGE_X[0], 0.9, laneZ(2), 'tag coral', 0)
            await all(tw.to(slowTag, { o: 1 }, { duration: 300 }), tint(ctx, [slabs[2][0]], mix(P.slate, P.coral, 0.4), { duration: 300 }))
            await run(selected.slice(18), { slowLane: 2 })
            await all(tw.to(slowTag, { o: 0 }, { duration: 300 }), tint(ctx, [slabs[2][0]], P.slate, { duration: 300 }), tw.to(resizeBar, { glow: 0.2 }, { duration: 300 }))
            ctx.stats([
              { label: 'Lanes', value: LANES, tone: 'cyan' },
              { label: 'Granules done', value: selected.length, of: selected.length, tone: 'volt', meter: 1 },
            ])
          },
        },
        {
          title: 'Lane results merge into one',
          body: 'Each lane holds a partial aggregation state. A final stage merges the n states into the result, here the single <code>max(price)</code>.',
          async run() {
            await all(tw.to(mergeNode, { a: 1 }, { duration: 400 }), tw.to(mergeLabel, { o: 1 }, { duration: 400 }), fit(ctx, FULL, { theta: -0.04, phi: 0.9, duration: 900 }))
            await all(
              ...states.map((s, l) =>
                packet(ctx, center(s), [MERGE_X, 0.4, 0], { color: LANE_COLORS[l], lift: 1, duration: 900, delay: l * 120, size: 0.24, glow: 0.5 }).then(() =>
                  tw.to(s, { h: 0.02, a: 0.3 }, { duration: 300 }),
                ),
              ),
            )
            await pulse(ctx, [mergeNode], 0.5, 0)
            await hop([MERGE_X, 0.4, 0], [RESULT_X, 0.3, 0], P.volt, 700, 0.6)
            await all(tw.to(result, { a: 1, h: 0.5 }, { duration: 500, ease: 'outBack' }), tw.to(resultLabel, { o: 1 }, { duration: 400 }))
            ctx.stats([
              { label: 'Lanes', value: LANES, tone: 'cyan' },
              { label: 'Result rows', value: 1, tone: 'volt' },
            ])
          },
        },
        {
          title: 'max_threads is only an upper bound',
          body: 'Small selections get fewer lanes: a lane needs enough rows (<code>merge_tree_min_rows_for_concurrent_read</code>, 163,840 by default). In the docs, a filtered query over 2.31M rows used <b>30 of 59</b> available cores.',
          hold: 3000,
          async run() {
            // a second, very selective query
            await all(tw.to(result, { a: 0, h: 0.02 }, { duration: 300 }), tw.to(resultLabel, { o: 0 }, { duration: 300 }), tw.to(states, { a: 1, h: 0.02 }, { duration: 300 }))
            processed.fill(0)
            const few = selected.filter((c) => c.data.r === 6 || c.data.r === 7).slice(0, 5)
            await tint(ctx, store, (c) => (few.includes(c) ? keyColor(c.data.r / (STORE_ROWS - 1)) : mix(P.slate, keyColor(c.data.r / (STORE_ROWS - 1)), 0.25)), {
              a: 1,
              duration: 500,
            })
            await all(...store.filter((c) => !few.includes(c)).map((c) => tw.to(c, { a: 0.1 }, { duration: 400 })))
            const idle = [2, 3]
            await all(...idle.flatMap((l) => [fade(ctx, [...slabs[l], states[l]], 0.15), tw.to([tracks[l], laneLabels[l]], { o: 0.2 }, { duration: 400 })]))
            const idleTag = world.label('idle', STAGE_X[1], 0.6, (laneZ(2) + laneZ(3)) / 2, 'tag', 0)
            await tw.to(idleTag, { o: 1 }, { duration: 300 })
            await run(few.slice(), { lanes: 2 })
            ctx.stats([
              { label: 'Lanes used', value: 2, of: LANES, tone: 'cyan', meter: 0.5 },
              { label: 'Granules', value: few.length, of: store.length, tone: 'volt' },
            ])
          },
        },
        {
          title: 'On a cluster, every shard does the same',
          body: 'With shards, each server runs its own lanes over its local data and the initiator merges the sub-results. See <b>Distributed queries</b>. ClickHouse Cloud gets the same effect with parallel replicas.',
          hold: 3400,
          async run() {
            // shrink the whole pipeline into a "server" and show two more
            const servers: Cell[] = []
            const sLabels: Label[] = []
            const init = cells.alloc({ x: 0, y: 0, z: 5.6, w: 1.6, h: 0.3, d: 0.7, a: 0, color: P.slate })
            const initLabel = world.label('<span class="k">initiator</span>merge', 1.6, 0.02, 5.6, 'tag volt', 0)
            for (let s = 0; s < 3; s++) {
              const x = (s - 1) * 6.4
              for (let l = 0; l < LANES; l++)
                for (let k = 0; k < 3; k++)
                  servers.push(cells.alloc({ x: x - 1.2 + k * 1.2, y: 0, z: 9.2 + (l - 1.5) * 0.42, w: 1, h: 0.06, d: 0.3, a: 0, color: mix(P.slate, LANE_COLORS[l], 0.35) }))
              sLabels.push(world.label(`<span class="k">shard</span>${s + 1}`, x, 0.02, 10.3, 'small', 0))
            }
            const old = [...store, ...slabs.flat(), ...states, resizeBar, mergeNode, result]
            await all(
              fade(ctx, old, 0.08, { duration: 800 }),
              tw.to([...laneLabels, ...stageLabels, storeLabel, resizeLabel, mergeLabel, resultLabel], { o: 0 }, { duration: 500 }),
              ...tracks.map((t) => tw.to(t, { o: 0.08 }, { duration: 500 })),
              fit(ctx, { x0: -9.4, x1: 9.4, z0: 3.6, z1: 10.8 }, { theta: -0.04, phi: 0.9, duration: 1500 }),
              tw.to(servers, { a: 1 }, { duration: 500, delay: tw.stagger(8) }),
              tw.to([...sLabels, initLabel], { o: 1 }, { duration: 500 }),
              tw.to(init, { a: 1 }, { duration: 500 }),
            )
            await all(...[-6.4, 0, 6.4].map((x, i) => packet(ctx, [x, 0.3, 8.6], [0, 0.4, 5.6], { lift: 1.4, duration: 1000, delay: i * 120, size: 0.22, glow: 0.5, color: P.cyan })))
            await pulse(ctx, [init], 0.5, 0.1)
            ctx.stats([
              { label: 'Shards', value: 3 },
              { label: 'Lanes per shard', value: LANES, tone: 'cyan' },
            ])
          },
        },
      ],
    }
  },
}
