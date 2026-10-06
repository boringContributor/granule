import type { Cell } from '../engine/Cells'
import type { Label } from '../engine/World'
import { P, keyColor, mix, scale } from '../engine/palette'
import { all, center, drop, fade, fit, fitRig, packet, setCamera, spawn, tint } from './kit'
import type { SceneDef } from './types'

const PARTS = 4
const ROWS = 8
const COLS = 3
const CPX = 0.4
const RPZ = 0.31
const PITCH = 2.15
const FULL = { x0: -4.6, x1: 6.2, z0: -2.1, z1: 2.3 }

const partX = (i: number) => (i - (PARTS - 1) / 2) * PITCH - 0.6
const rowZ = (r: number) => (r - (ROWS - 1) / 2) * RPZ
const rowColor = (p: number, r: number, c: number) => scale(keyColor((p * ROWS + r) / (PARTS * ROWS - 1)), 0.95 - c * 0.13)

interface PartV {
  name: string
  x: number
  rows: Cell[][]
  label: Label
  mask: Cell[] | null
}

export const mutations: SceneDef = {
  id: 'mutations',
  title: 'Avoid mutations',
  kicker: 'Why UPDATE rewrites whole parts',
  blurb: 'Mutations rewrite every affected part; lightweight deletes and ReplacingMergeTree avoid that.',
  docs: 'https://clickhouse.com/docs/concepts/best-practices/avoid-mutations',
  create(ctx) {
    const { world, tw, cells } = ctx

    const parts: PartV[] = Array.from({ length: PARTS }, (_, i) => {
      const x = partX(i)
      const name = `all_${i + 1}_${i + 1}_0`
      return {
        name,
        x,
        rows: Array.from({ length: ROWS }, (_, r) =>
          Array.from({ length: COLS }, (_, c) => spawn(ctx, { x: x + (c - 1) * CPX, z: rowZ(r), w: 0.34, d: 0.23, h: 0.16, color: rowColor(i, r, c), data: { p: i, r, c } })),
        ),
        label: world.label(name, x, 0.02, rowZ(0) - 0.45, 'small', 0),
        mask: null,
      }
    })
    const tag = world.label('', 0, 1.4, 0, 'tag', 0)
    const showTag = (html: string, x: number, z: number, tone: string) => {
      tag.set(html)
      tag.el.className = `lbl tag ${tone}`
      tag.x = x
      tag.z = z
      return tw.to(tag, { o: 1 }, { duration: 300 })
    }
    const hideTag = () => tw.to(tag, { o: 0 }, { duration: 250 })

    // the rows the UPDATE touches: one in part 1 and one in part 3
    const changed: [number, number][] = [
      [0, 5],
      [2, 2],
    ]

    /** Rewrite a whole part: every row is written again, the changed row with its new value. */
    const rewrite = async (pi: number, version: number, slow = 1) => {
      const p = parts[pi]
      const old = p.rows.flat()
      const fresh = p.rows.map((row, r) =>
        row.map((c, ci) => {
          const hit = changed.some(([a, b]) => a === pi && b === r)
          return cells.alloc({ x: c.x, y: 1.1, z: c.z, w: c.w, d: c.d, h: c.h, a: 0, color: hit ? scale(P.cyan, 1 - ci * 0.12) : rowColor(pi, r, ci), data: { ...c.data } })
        }),
      )
      await tint(ctx, old, (c) => mix(P.slate, [c.r, c.g, c.b], 0.3), { a: 0.14, duration: 400 })
      await all(...fresh.map((row, r) => tw.to(row, { a: 1, y: 0 }, { duration: 380 * slow, delay: r * 120 * slow, ease: 'outCubic' })))
      await fade(ctx, old, 0, { duration: 300 })
      cells.release(old)
      p.rows = fresh
      p.name = `all_${pi + 1}_${pi + 1}_0_${version}`
      p.label.set(p.name)
    }

    setCamera(ctx, fitRig(ctx, FULL, { theta: -0.1, phi: 0.8 }))

    const stats = (changedRows: number, rewritten: number, tone: 'coral' | 'cyan' = 'coral') =>
      ctx.stats([
        { label: 'Rows changed', value: changedRows },
        { label: 'Rows rewritten', value: rewritten, tone },
        { label: 'Parts', value: parts.length },
      ])

    return {
      steps: [
        {
          title: 'Parts are immutable',
          body: 'Each part is written once and never edited in place. Each box here stands for a block of about 300K rows, so each part holds roughly <b>2.5M rows</b>.',
          async run() {
            await all(
              ...parts.map((p, i) => tw.wait(i * 150).then(() => drop(ctx, p.rows.flat(), { each: 6, duration: 700 }))),
              tw.to(parts.map((p) => p.label), { o: 1 }, { duration: 600, delay: tw.stagger(150) }),
            )
            stats(0, 0, 'cyan')
          },
        },
        {
          title: 'An UPDATE rewrites every affected part',
          body: '<code>ALTER TABLE … UPDATE</code> is a <b>mutation</b>. To change two rows, ClickHouse rewrites both parts that contain them, every column of every row. That’s write amplification.',
          code: "ALTER TABLE orders UPDATE status = 'paid'\nWHERE order_id IN (1042, 7731)",
          async run() {
            const hits = changed.flatMap(([pi, r]) => parts[pi].rows[r])
            await all(tint(ctx, hits, P.coral, { duration: 400, glow: 0.35 }), showTag('2 rows match', parts[1].x, rowZ(0) - 0.9, 'coral'))
            await hideTag()
            await rewrite(0, 5)
            stats(2, 2_500_000)
          },
        },
        {
          title: 'Mutations run in the background',
          body: 'While a mutation runs, queries can read a mix of rewritten and old parts. It can’t be rolled back and resumes after a restart. Watch <code>system.mutations</code>; stop it with <code>KILL MUTATION</code>.',
          code: "SELECT command, parts_to_do, is_done FROM system.mutations",
          async run() {
            const q: [number, number, number] = [partX(1) + PITCH / 2, 0.3, 3]
            const reads = parts.map((p) => packet(ctx, q, center(p.rows[3][1]), { lift: 1.4, duration: 900, size: 0.14, color: P.mist }))
            await all(...reads, showTag('<span class="k">reader sees</span>new + old parts', q[0], 2.2, 'violet'))
            await all(hideTag(), rewrite(2, 5, 1.3))
            stats(2, 5_000_000)
          },
        },
        {
          title: 'Lightweight DELETE only masks rows',
          body: '<code>DELETE FROM</code> doesn’t rewrite data. It updates a hidden <code>_row_exists</code> mask so deleted rows are skipped at query time, and merges drop them later.',
          code: 'DELETE FROM orders WHERE customer_id = 42',
          async run() {
            const deleted: [number, number][] = [
              [1, 1],
              [1, 6],
              [2, 4],
              [3, 3],
            ]
            for (const p of parts) {
              p.mask = p.rows.map((_, r) =>
                cells.alloc({ x: p.x + 2 * CPX - 0.04, z: rowZ(r), w: 0.1, d: 0.23, h: 0.16, a: 0, color: scale(P.lime, 0.75), data: { r } }),
              )
            }
            await all(...parts.map((p) => tw.to(p.mask!, { a: 1 }, { duration: 400, delay: tw.stagger(30) })))
            const hitRows = deleted.map(([pi, r]) => parts[pi].rows[r])
            const hitMasks = deleted.map(([pi, r]) => parts[pi].mask![r])
            hitMasks.forEach((m) => (m.data.deleted = true))
            await all(
              tint(ctx, hitMasks, P.coral, { duration: 400, glow: 0.2 }),
              tint(ctx, hitRows.flat(), (c) => mix(P.slate, [c.r, c.g, c.b], 0.3), { a: 0.14, duration: 500 }),
              showTag('<span class="k">_row_exists</span>0 → skipped', parts[2].x + 2 * CPX, rowZ(0) - 0.9, 'cyan'),
            )
            ctx.stats([
              { label: 'Rows deleted', value: 4 },
              { label: 'Rows rewritten', value: 0, tone: 'cyan' },
            ])
          },
        },
        {
          title: 'Merges clean up deleted rows',
          body: 'The next merge simply leaves masked rows out. The rewrite happens as part of work ClickHouse was doing anyway.',
          async run() {
            await hideTag()
            const a = parts[2]
            const b = parts[3]
            const keepRows: Cell[][] = []
            const dropCells: Cell[] = []
            for (const p of [a, b])
              p.rows.forEach((row, r) => {
                if (p.mask![r].data.deleted) dropCells.push(...row, p.mask![r])
                else keepRows.push(row)
              })
            const masks = [a, b].flatMap((p) => p.mask!.filter((m) => !dropCells.includes(m)))
            const mx = (a.x + b.x) / 2
            const n = keepRows.length
            await all(fade(ctx, dropCells, 0, { duration: 400 }), fade(ctx, masks, 0, { duration: 400 }), tw.to([a.label, b.label], { o: 0 }, { duration: 300 }))
            cells.release([...dropCells, ...masks])
            await tw.to(keepRows.flat(), { y: 0.8 }, { duration: 350 })
            await all(
              ...keepRows.map((row, r) =>
                tw.to(row, { x: (c: Cell) => mx + (c.data.c - 1) * CPX, z: (r - (n - 1) / 2) * RPZ * 0.62 }, { duration: 800, ease: 'inOutCubic' }),
              ),
              tw.to(keepRows.flat(), { d: 0.13 }, { duration: 800 }),
            )
            await tw.to(keepRows.flat(), { y: 0 }, { duration: 300 })
            const merged: PartV = { name: 'all_3_4_1', x: mx, rows: keepRows, label: a.label, mask: null }
            a.label.set(merged.name)
            a.label.x = mx
            world.removeLabel(b.label)
            parts.splice(2, 2, merged)
            await tw.to(a.label, { o: 1 }, { duration: 300 })
            ctx.stats([
              { label: 'Rows deleted', value: 4 },
              { label: 'Parts', value: parts.length },
            ])
          },
        },
        {
          title: 'Or insert a new version: ReplacingMergeTree',
          body: 'Model changes as inserts. A <code>ReplacingMergeTree</code> keeps only the latest version of each sorting key when parts merge. Query with <code>FINAL</code> if you need it exact before then. Expiring old data? Drop whole partitions.',
          code: 'ENGINE = ReplacingMergeTree(version) ORDER BY order_id',
          hold: 3800,
          async run() {
            const target = parts[1]
            const rowsIdx = [2, 5]
            const nx = 5.1
            const fresh = rowsIdx.map((r, k) =>
              Array.from({ length: COLS }, (_, c) => cells.alloc({ x: nx + (c - 1) * CPX, z: (k - 0.5) * RPZ, y: 2, w: 0.34, d: 0.23, h: 0.16, a: 0, color: scale(P.cyan, 1 - c * 0.12), data: { r, c } })),
            )
            const newLabel = world.label('all_5_5_0 · version 2', nx, 0.02, -0.75, 'small', 0)
            await all(...fresh.map((row) => tw.to(row, { a: 1, y: 0 }, { duration: 700, ease: 'outExpo' })), tw.to(newLabel, { o: 1 }, { duration: 400 }))
            const olds = rowsIdx.map((r) => target.rows[r])
            await tint(ctx, olds.flat(), P.coral, { duration: 300, glow: 0.25 })
            await tw.to(fresh.flat(), { y: 0.9 }, { duration: 300 })
            await all(
              ...fresh.map((row, k) => tw.to(row, { x: (c: Cell) => target.x + (c.data.c - 1) * CPX, z: rowZ(rowsIdx[k]) }, { duration: 1000, ease: 'inOutCubic' })),
              fade(ctx, olds.flat(), 0, { duration: 700 }),
              tw.to(newLabel, { o: 0 }, { duration: 400 }),
            )
            await tw.to(fresh.flat(), { y: 0 }, { duration: 300 })
            cells.release(olds.flat())
            rowsIdx.forEach((r, k) => (target.rows[r] = fresh[k]))
            target.label.set('all_2_5_1')
            await fit(ctx, FULL, { theta: -0.06, phi: 0.8, duration: 800 })
            ctx.stats([
              { label: 'Rows replaced', value: 2, tone: 'cyan' },
              { label: 'Extra rewrite', value: 'merge only', tone: 'cyan' },
            ])
          },
        },
      ],
    }
  },
}
