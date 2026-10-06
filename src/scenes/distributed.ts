import type { Cell } from '../engine/Cells'
import type { Label } from '../engine/World'
import { COLUMN_HUES, P, mix, scale } from '../engine/palette'
import { all, center, drop, fade, fit, fitRig, fmt, packet, rng, setCamera, spawn, tint, type V3 } from './kit'
import type { SceneDef } from './types'

const SHARDS = [-5.4, 0, 5.4]
const SHARD_Z = -2.4
const COLS = ['ts', 'country', 'user_id', 'url']
const G = 9
const FULL = { x0: -7, x1: 7, z0: -7, z1: 4.4 }
const CPX = 0.4
const GPZ = 0.28
const COUNTRIES = ['DE', 'US', 'FR', 'JP', 'BR']
const CC = [COLUMN_HUES[0], COLUMN_HUES[4], COLUMN_HUES[2], COLUMN_HUES[3], COLUMN_HUES[5]]
const INIT: V3 = [0, 0, 3.6]
const AGG_Z = 0.4
const REPLICA_DZ = -2.9

export const distributed: SceneDef = {
  id: 'distributed',
  title: 'Distributed queries',
  docs: 'https://clickhouse.com/docs/engines/table-engines/special/distributed',
  kicker: 'Fan out, aggregate, merge',
  blurb: 'Every shard does the heavy lifting locally; only small partial results travel.',
  create(ctx) {
    const { world, tw } = ctx
    const rand = rng(3)

    interface Shard {
      x: number
      grid: Cell[][]
      replica: Cell[]
      bars: Cell[]
      counts: number[]
      label: Label
      replicaLabel: Label
      arc: ReturnType<typeof world.arc>
    }

    const shards: Shard[] = SHARDS.map((x, s) => {
      const grid = Array.from({ length: G }, (_, g) =>
        COLS.map((_, c) =>
          spawn(ctx, {
            x: x + (c - 1.5) * CPX,
            z: SHARD_Z + (g - (G - 1) / 2) * GPZ,
            w: 0.32,
            d: 0.2,
            h: 0.16,
            color: c === 1 ? COLUMN_HUES[1] : scale(COLUMN_HUES[c === 0 ? 0 : c + 1], 0.75),
            data: { c },
          }),
        ),
      )
      const replica = Array.from({ length: G * COLS.length }, (_, i) =>
        spawn(ctx, {
          x: x + ((i % COLS.length) - 1.5) * CPX,
          z: SHARD_Z + REPLICA_DZ + (Math.floor(i / COLS.length) - (G - 1) / 2) * GPZ,
          w: 0.32,
          d: 0.2,
          h: 0.16,
          color: P.steel,
        }),
      )
      const weights = COUNTRIES.map(() => 0.3 + rand())
      const total = G * 8192
      const wsum = weights.reduce((a, b) => a + b, 0)
      const counts = weights.map((w) => Math.round((w / wsum) * total))
      const bars = COUNTRIES.map((_, k) =>
        ctx.cells.alloc({ x: x + (k - 2) * 0.34, y: 0, z: AGG_Z, w: 0.26, h: 0.02, d: 0.26, a: 0, color: CC[k], data: { k } }),
      )
      const label = world.label(`<span class="k">shard</span>${s + 1}`, x - 1.4, 0.02, SHARD_Z, 'tag', 0)
      const replicaLabel = world.label(`replica 2 · idle`, x, 0.02, SHARD_Z + REPLICA_DZ - (G / 2) * GPZ - 0.35, 'small', 0)
      const arc = world.arc([INIT[0], 0.5, INIT[2] - 0.4], [x, 0.3, SHARD_Z + (G / 2) * GPZ], 2.2, P.mist, 0, true)
      return { x, grid, replica, bars, counts, label, replicaLabel, arc }
    })

    const initBox = ctx.cells.alloc({ x: INIT[0], y: 0, z: INIT[2], w: 2.2, h: 0.36, d: 0.8, a: 0, color: P.slate })
    const initLabel = world.label('<span class="k">initiator</span>events_dist', INIT[0] + 2, 0.02, INIT[2], 'tag volt', 0)
    const finalBars = COUNTRIES.map((_, k) =>
      ctx.cells.alloc({ x: (k - 2) * 0.42, y: 0.36, z: INIT[2], w: 0.32, h: 0.02, d: 0.32, a: 0, color: CC[k] }),
    )
    const finalLabels = COUNTRIES.map((c, k) => world.label(c, (k - 2) * 0.42, 0.02, INIT[2] + 0.75, 'mark', 0))
    const totals = COUNTRIES.map((_, k) => shards.reduce((s, sh) => s + sh.counts[k], 0))
    const maxTotal = Math.max(...totals)

    setCamera(ctx, fitRig(ctx, FULL, { theta: 0, phi: 0.9 }))


    return {
      steps: [
        {
          title: 'One query, one initiator',
          body: 'A <code>Distributed</code> table stores nothing itself. The server that receives the query becomes the <b>initiator</b> and plans it across the cluster.',
          code: 'SELECT country, count() FROM events_dist GROUP BY country',
          async run() {
            await all(
              tw.to(initBox, { a: 1 }, { duration: 600 }),
              tw.to(initLabel, { o: 1 }, { duration: 600 }),
              ...shards.map((s, i) =>
                tw.wait(150 * i).then(() =>
                  all(
                    drop(ctx, s.grid.flat(), { each: 4, duration: 700 }),
                    drop(ctx, s.replica, { each: 2, duration: 700, a: 0.16 }),
                    tw.to([s.label, s.replicaLabel], { o: 1 }, { duration: 500 }),
                  ),
                ),
              ),
              fit(ctx, FULL, { theta: -0.06, phi: 0.88, duration: 2400 }),
            )
            ctx.stats([
              { label: 'Shards', value: 3 },
              { label: 'Rows per shard', value: G * 8192 },
            ])
          },
        },
        {
          title: 'The query fans out to every shard',
          body: 'The initiator rewrites the query for the local tables and sends it to <b>one healthy replica</b> of each shard. The other replicas stay idle.',
          async run() {
            await all(
              ...shards.map((s) => tw.to(s.arc.line, { o: 0.55 }, { duration: 500 })),
              pulseBox(),
            )
            await all(...shards.map((s) => packet(ctx, s.arc.path(0), s.arc.path(1), { lift: 0, duration: 1100, size: 0.18 }).then(() => {})))
            await all(...shards.map((s) => pulseShard(s)))
          },
        },
        {
          title: 'Each shard scans its own data',
          body: 'All shards work in parallel and only on their local parts. This query needs a single column, <code>country</code>, so the other column files stay closed.',
          async run() {
            const others = shards.flatMap((s) => s.grid.flatMap((r) => r.filter((c) => c.data.c !== 1)))
            const country = shards.flatMap((s) => s.grid.map((r) => r[1]))
            await fade(ctx, others, 0.08, { duration: 600 })
            await all(...shards.map((s) => tw.to(s.grid.map((r) => r[1]), { glow: 0.7, y: 0.08 }, { duration: 300, delay: tw.stagger(70) })))
            await tw.to(country, { glow: 0.25 }, { duration: 400 })
            ctx.stats([
              { label: 'Rows scanned', value: 3 * G * 8192, tone: 'cyan' },
              { label: 'Columns read', value: 1, of: 4 },
            ])
          },
        },
        {
          title: '…and aggregates locally',
          body: 'Each shard builds its own hash table: one counter per country. Hundreds of thousands of rows collapse into five small <b>partial states</b>.',
          async run() {
            const jobs: Promise<unknown>[] = []
            shards.forEach((s) => {
              s.grid.forEach((row, g) => {
                for (let j = 0; j < 3; j++) {
                  const k = Math.floor(((g * 3 + j) * 2654435761) % 5)
                  jobs.push(packet(ctx, center(row[1]), [s.bars[k].x, 0.3, AGG_Z], { color: CC[k], lift: 0.6, duration: 600, delay: g * 70 + j * 40, size: 0.1 }))
                }
              })
              const max = Math.max(...s.counts)
              jobs.push(tw.to(s.bars, { a: 1 }, { duration: 300 }))
              jobs.push(tw.to(s.bars, { h: (c: Cell) => 0.15 + (s.counts[c.data.k] / max) * 1.1 }, { duration: 1300, delay: 300, ease: 'outCubic' }))
            })
            await all(...jobs)
            await tw.to(shards.flatMap((s) => s.grid.map((r) => r[1])), { glow: 0, y: 0 }, { duration: 400 })
          },
        },
        {
          title: 'Only partial states travel back',
          body: 'Instead of shipping rows, each shard returns its five intermediate aggregation states. That’s 15 tiny rows on the network instead of 221K.',
          async run() {
            await all(...shards.map((s) => tw.to(s.arc.line, { o: 0.55, r: P.cyan[0], g: P.cyan[1], b: P.cyan[2] }, { duration: 400 })))
            const jobs: Promise<unknown>[] = []
            shards.forEach((s, si) => {
              s.bars.forEach((b, k) => {
                const from: V3 = [b.x, b.h + 0.2, b.z]
                const to: V3 = [finalBars[k].x, 0.8, INIT[2]]
                jobs.push(packet(ctx, from, to, { color: CC[k], lift: 2.4, duration: 1200, delay: si * 120 + k * 60, size: 0.2 }))
              })
              jobs.push(tw.to(s.bars, { a: 0.2 }, { duration: 800, delay: 400 }))
            })
            await all(...jobs)
            ctx.stats([
              { label: 'Rows scanned', value: 3 * G * 8192, tone: 'cyan' },
              { label: 'Rows sent over network', value: 15, tone: 'volt' },
            ])
          },
        },
        {
          title: 'The initiator merges and answers',
          body: 'The initiator merges the partial states into final counts and streams the result to the client. Adding shards adds scan power almost linearly.',
          hold: 3400,
          async run() {
            await all(
              fit(ctx, { x0: -5.5, x1: 5.5, z0: -1.5, z1: 5, y1: 2.4 }, { phi: 0.92, theta: -0.1, duration: 1500 }),
              tw.to(finalBars, { a: 1 }, { duration: 300 }),
              tw.to(finalBars, { h: (_: Cell, i: number) => 0.2 + (totals[i] / maxTotal) * 1.6, glow: 0.35 }, { duration: 1400, ease: 'outCubic', delay: tw.stagger(80) }),
              ...finalLabels.map((l, k) => {
                l.set(`<span>${COUNTRIES[k]} ${fmt(totals[k])}</span>`)
                return tw.to(l, { o: 1 }, { duration: 600, delay: 500 + k * 80 })
              }),
              tint(ctx, [initBox], mix(P.slate, P.volt, 0.15), { duration: 600 }),
            )
            ctx.stats([
              { label: 'Result rows', value: 5, tone: 'volt' },
              { label: 'Rows scanned', value: 3 * G * 8192, tone: 'cyan' },
              { label: 'Rows sent over network', value: 15 },
            ])
          },
        },
      ],
    }

    function pulseBox() {
      return tw.to(initBox, { glow: 0.6 }, { duration: 300 }).then(() => tw.to(initBox, { glow: 0 }, { duration: 500 }))
    }
    function pulseShard(s: Shard) {
      const top = s.grid.flat()
      return tw.to(top, { glow: 0.35 }, { duration: 250 }).then(() => tw.to(top, { glow: 0 }, { duration: 500 }))
    }
  },
}
