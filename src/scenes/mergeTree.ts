import type { Cell } from '../engine/Cells'
import type { Label, LineHandle } from '../engine/World'
import { COLUMN_HUES, P, keyColor, mix, scale } from '../engine/palette'
import { all, fade, fit, fitRig, rng, setCamera, tint } from './kit'
import type { Ctx, SceneDef } from './types'

const COLS = ['ts', 'user_id', 'url']
const COL_DIM = [1, 0.78, 0.64]
const CPX = 0.42
const GPZ = 0.3
const PART_PITCH = 1.78
const PER_ROW = 6
const LANE_X0 = -7.2
const LANE_Z0 = -3.2
const MAIN = { x0: -8.4, x1: 2.4, z0: -4.2, z1: 1.2 }
const MAIN_DEEP = { x0: -8.4, x1: 2.4, z0: -4.2, z1: 3.8 }
const VX = 6.4 // variants area
const VARIANTS = { x0: 4.4, x1: 12.4, z0: -3.4, z1: 1.6 }

interface Row {
  key: number
  cells: Cell[]
}

interface Part {
  minBlock: number
  maxBlock: number
  level: number
  rows: Row[]
  label: Label
  x: number
  z: number
}

const partName = (p: Part) => `all_${p.minBlock}_${p.maxBlock}_${p.level}`

function makeLane(ctx: Ctx) {
  const { world, cells, tw } = ctx
  const rand = rng(42)
  let block = 0
  const parts: Part[] = []
  const inactive: Cell[] = []
  const outline: LineHandle = world.rect(LANE_X0 + (PER_ROW * PART_PITCH) / 2 - 0.85, 0.005, LANE_Z0 + 3.1, PER_ROW * PART_PITCH + 0.3, 8, P.steel, 0, true)
  const title = world.label('<span class="k">table</span>events', LANE_X0 - 0.4, 0.02, LANE_Z0 - 1.0, 'small', 0)

  const layout = () => {
    let rowZ = LANE_Z0
    let rowDepth = 0
    parts.forEach((p, i) => {
      const col = i % PER_ROW
      if (col === 0 && i > 0) {
        rowZ += rowDepth * GPZ + 0.95
        rowDepth = 0
      }
      p.x = LANE_X0 + col * PART_PITCH
      p.z = rowZ
      rowDepth = Math.max(rowDepth, p.rows.length)
    })
  }

  const slot = (p: Part, g: number, c: number) => ({ x: p.x + (c - 1) * CPX, z: p.z + g * GPZ })
  const levelTint = (key: number, c: number) => scale(keyColor(key), COL_DIM[c])

  const settle = (duration = 900, skip?: Part) => {
    layout()
    const moves: Promise<void>[] = []
    for (const p of parts) {
      if (p === skip) continue
      p.rows.forEach((r, g) =>
        r.cells.forEach((c, ci) => {
          const s = slot(p, g, ci)
          if (Math.abs(c.x - s.x) > 1e-3 || Math.abs(c.z - s.z) > 1e-3) moves.push(tw.to(c, { x: s.x, z: s.z }, { duration, ease: 'inOutCubic' }))
        }),
      )
      moves.push(tw.to(p.label, { x: p.x, z: p.z - 0.42 }, { duration, ease: 'inOutCubic' }))
    }
    return all(...moves)
  }

  /** INSERT: a sorted level-0 part drops in. */
  const insert = async (granules: number, duration = 900) => {
    block++
    const keys = Array.from({ length: granules }, () => rand()).sort((a, b) => a - b)
    const part: Part = {
      minBlock: block,
      maxBlock: block,
      level: 0,
      rows: keys.map((key) => ({ key, cells: COLS.map((_, c) => cells.alloc({ w: 0.34, d: 0.24, h: 0.2, a: 0, color: levelTint(key, c), data: { col: c } })) })),
      label: world.label('', 0, 0.02, 0, 'small', 0),
      x: 0,
      z: 0,
    }
    part.label.set(partName(part))
    parts.push(part)
    layout()
    part.label.x = part.x
    part.label.z = part.z - 0.42
    part.rows.forEach((r, g) =>
      r.cells.forEach((c, ci) => {
        const s = slot(part, g, ci)
        c.x = s.x
        c.z = s.z
        c.y = 2.2
      }),
    )
    const flat = part.rows.flatMap((r) => r.cells)
    await all(tw.to(flat, { y: 0, a: 1 }, { duration, ease: 'outExpo', delay: tw.stagger(8) }), tw.to(part.label, { o: 1 }, { duration: duration * 0.6 }))
    return part
  }

  /** Replace `sources` by a merged part in the lane; returns it without animating. */
  const plan = (sources: Part[]) => {
    const rows = sources.flatMap((p) => p.rows).sort((a, b) => a.key - b.key)
    const merged: Part = {
      minBlock: Math.min(...sources.map((p) => p.minBlock)),
      maxBlock: Math.max(...sources.map((p) => p.maxBlock)),
      level: Math.max(...sources.map((p) => p.level)) + 1,
      rows,
      label: world.label('', 0, 0.02, 0, 'small', 0),
      x: 0,
      z: 0,
    }
    merged.label.set(partName(merged))
    // outdated parts stay on disk, inactive, until cleanup
    const ghosts = sources.flatMap((p) => p.rows.flatMap((r) => r.cells.map((c) => cells.alloc({ x: c.x, y: 0, z: c.z, w: c.w, h: c.h, d: c.d, r: c.r, g: c.g, b: c.b, a: 0 }))))
    inactive.push(...ghosts)
    const idx = parts.indexOf(sources[0])
    for (const s of sources) parts.splice(parts.indexOf(s), 1)
    parts.splice(idx, 0, merged)
    layout()
    merged.label.x = merged.x
    merged.label.z = merged.z - 0.42
    return { merged, ghosts, rows }
  }

  /** MERGE: lift, merge-sort into the new part, land. */
  const merge = async (sources: Part[], duration = 1500) => {
    const { merged, ghosts, rows } = plan(sources)
    const src = rows.flatMap((r) => r.cells)
    await all(...sources.map((p) => tw.to(p.label, { o: 0 }, { duration: 400 })), tw.to(src, { glow: 0.22, y: 1.1 }, { duration: duration * 0.25, ease: 'outQuad', delay: tw.stagger(1.2) }))
    ghosts.forEach((g) => (g.a = 0.1))
    await all(
      ...rows.map((r, g) =>
        tw.to(r.cells, { x: (_: Cell, ci: number) => slot(merged, g, ci).x, z: (_: Cell, ci: number) => slot(merged, g, ci).z }, { duration: duration * 0.5, ease: 'inOutCubic', delay: g * 10 }),
      ),
      settle(duration * 0.5, merged),
    )
    await all(tw.to(src, { y: 0, glow: 0 }, { duration: duration * 0.25, ease: 'inQuad' }), tw.to(merged.label, { o: 1 }, { duration: 500 }))
    for (const p of sources) world.removeLabel(p.label)
    return merged
  }

  /** The same merge, slowed down into its four stages. */
  const mergeStaged = async (sources: Part[]) => {
    const { merged, ghosts, rows } = plan(sources)
    const src = rows.flatMap((r) => r.cells)
    const stage = world.label('', 0, 2.4, 0, 'tag volt', 0)
    const midX = (Math.min(...sources.map((p) => p.x)) + Math.max(...sources.map((p) => p.x))) / 2
    stage.x = midX
    stage.z = merged.z
    const show = async (html: string) => {
      await tw.to(stage, { o: 0 }, { duration: 150 })
      stage.set(html)
      await tw.to(stage, { o: 1 }, { duration: 250 })
    }

    await all(...sources.map((p) => tw.to(p.label, { o: 0 }, { duration: 400 })), show('1 · decompress &amp; load'))
    ghosts.forEach((g) => (g.a = 0.1))
    await tw.to(src, { y: 1.3, w: 0.4, d: 0.28, h: 0.26, glow: 0.25 }, { duration: 900, ease: 'outBack', delay: tw.stagger(4) })
    await tw.wait(300)

    await show('2 · merge-sort the rows')
    stage.x = merged.x
    await all(
      tw.to(stage, { x: merged.x }, { duration: 900 }),
      ...rows.map((r, g) =>
        tw.to(r.cells, { x: (_: Cell, ci: number) => slot(merged, g, ci).x, z: (_: Cell, ci: number) => slot(merged, g, ci).z }, { duration: 1200, ease: 'inOutCubic', delay: g * 25 }),
      ),
      settle(1200, merged),
    )

    await show('3 · build a new sparse index')
    const marks = rows
      .filter((_, g) => g % 4 === 0)
      .map((r, i) => cells.alloc({ x: merged.x - 0.85, y: 1.3, z: merged.z + i * 4 * GPZ, w: 0.18, h: 0.18, d: 0.18, a: 0, glow: 0.3, color: keyColor(r.key) }))
    await tw.to(marks, { a: 1 }, { duration: 400, delay: tw.stagger(120) })

    await show('4 · compress &amp; write a new part')
    await all(
      tw.to(src, { y: 0, w: 0.34, d: 0.24, h: 0.2, glow: 0 }, { duration: 800, ease: 'inQuad', delay: tw.stagger(3) }),
      tw.to(marks, { y: 0, glow: 0 }, { duration: 800, ease: 'inQuad' }),
      tw.to(merged.label, { o: 1 }, { duration: 600, delay: 400 }),
    )
    await tw.wait(700)
    await all(tw.to(stage, { o: 0 }, { duration: 400 }), fade(ctx, marks, 0, { duration: 600 }))
    cells.release(marks)
    world.removeLabel(stage)
    for (const p of sources) world.removeLabel(p.label)
    return merged
  }

  return { parts, inactive, outline, title, insert, merge, mergeStaged, settle }
}

/** A tiny two-column table (key, value) for the engine variants. */
interface VRow {
  key: number
  val: number
  ver: number
  k: Cell
  v: Cell
  label: Label
}

export const mergeTree: SceneDef = {
  id: 'merges',
  title: 'Table part merges',
  kicker: 'Small parts roll up into big ones',
  docs: 'https://clickhouse.com/docs/concepts/core-concepts/merges',
  blurb: 'Background merges combine small parts into bigger ones, level by level.',
  create(ctx) {
    const { tw, world, cells } = ctx
    const lane = makeLane(ctx)
    const totals = { inserts: 0, merges: 0 }
    const maxLevel = () => Math.max(0, ...lane.parts.map((p) => p.level))
    const stats = (extra: { label: string; value: number | string; tone?: 'volt' | 'coral' | 'cyan' | 'violet' }[] = []) =>
      ctx.stats([
        { label: 'Active parts', value: lane.parts.length, tone: 'volt' },
        { label: 'Merges', value: totals.merges, tone: 'cyan' },
        { label: 'Highest level', value: maxLevel(), tone: 'violet' },
        ...extra,
      ])

    setCamera(ctx, fitRig(ctx, MAIN, { theta: -0.12, phi: 0.86 }))

    // ---- engine variants area ----
    const letters = 'ABCDEF'
    const vrows: VRow[] = []
    const vlabels: Label[] = []
    const vrow = (key: number, val: number, ver: number, x: number, z: number, kind: 'replace' | 'sum') => {
      const k = cells.alloc({ x, y: 0, z, w: 0.38, h: 0.18, d: 0.3, a: 0, color: keyColor(key / 5) })
      const vColor = kind === 'replace' ? mix(P.slate, COLUMN_HUES[0], ver === 2 ? 1 : 0.45) : COLUMN_HUES[4]
      const v = cells.alloc({ x: x + 0.46, y: 0, z, w: 0.38, h: kind === 'sum' ? 0.12 * val : 0.18, d: 0.3, a: 0, color: vColor })
      const text = kind === 'replace' ? `${letters[key]} <span class="k">v${ver}</span>` : `${letters[key]} <span class="k">${val}</span>`
      const label = world.label(text, x - 0.55, 0.02, z, 'mark', 0)
      const r: VRow = { key, val, ver, k, v, label }
      vrows.push(r)
      return r
    }
    const vtitle = (html: string, x: number) => {
      const l = world.label(html, x, 0.02, -3.1, 'small', 0)
      vlabels.push(l)
      return l
    }
    const clearVariants = async () => {
      await all(fade(ctx, vrows.flatMap((r) => [r.k, r.v]), 0, { duration: 400 }), tw.to([...vrows.map((r) => r.label), ...vlabels], { o: 0 }, { duration: 300 }))
      cells.release(vrows.flatMap((r) => [r.k, r.v]))
      for (const l of [...vrows.map((r) => r.label), ...vlabels]) world.removeLabel(l)
      vrows.length = 0
      vlabels.length = 0
    }
    const rz = (i: number) => -2.4 + i * 0.5

    /** Merge two variant parts into one at MX; rows with equal keys collapse into one slot. */
    const variantMerge = async (a: VRow[], b: VRow[], kind: 'replace' | 'sum') => {
      const MX = VX + 4.2
      const keys = [...new Set([...a, ...b].map((r) => r.key))].sort((x, y) => x - y)
      const title = vtitle(kind === 'replace' ? 'merged · latest version kept' : 'merged · values summed', MX + 0.2)
      await all(
        ...[...a, ...b].map((r) => {
          const z = rz(keys.indexOf(r.key))
          return all(
            tw.to([r.k], { x: MX, z }, { duration: 1100, ease: 'inOutCubic' }),
            tw.to([r.v], { x: MX + 0.46, z }, { duration: 1100, ease: 'inOutCubic' }),
            tw.to(r.label, { x: MX - 0.55, z }, { duration: 1100, ease: 'inOutCubic' }),
          )
        }),
        tw.to(title, { o: 1 }, { duration: 500, delay: 600 }),
      )
      const jobs: Promise<unknown>[] = []
      for (const key of keys) {
        const same = [...a, ...b].filter((r) => r.key === key)
        if (same.length < 2) continue
        if (kind === 'replace') {
          const latest = same.reduce((x, y) => (y.ver > x.ver ? y : x))
          for (const r of same) if (r !== latest) jobs.push(tint(ctx, [r.k, r.v], P.coral, { glow: 0.4, duration: 300 }).then(() => fade(ctx, [r.k, r.v], 0, { duration: 500 })), tw.to(r.label, { o: 0 }, { duration: 500 }))
        } else {
          const keep = same[0]
          const total = same.reduce((s, r) => s + r.val, 0)
          for (const r of same.slice(1)) jobs.push(fade(ctx, [r.k, r.v], 0, { duration: 400 }), tw.to(r.label, { o: 0 }, { duration: 400 }))
          keep.label.set(`${letters[key]} <span class="k">${total}</span>`)
          jobs.push(tw.to(keep.v, { h: 0.12 * total, glow: 0.3 }, { duration: 800, ease: 'outBack' }).then(() => tw.to(keep.v, { glow: 0 }, { duration: 400 })))
        }
      }
      await all(...jobs)
      return keys.length
    }

    return {
      steps: [
        {
          title: 'Inserts create level-0 parts',
          body: 'Every insert writes a new, sorted part. Its name ends in its <b>merge level</b>: <code>0</code> means it has never been merged.',
          async run() {
            await all(tw.to(lane.outline, { o: 0.5 }, { duration: 500 }), tw.to(lane.title, { o: 1 }, { duration: 500 }))
            const sizes = [3, 4, 2, 4, 3, 3]
            await all(
              ...sizes.map((g, i) =>
                tw.wait(i * 300).then(async () => {
                  totals.inserts++
                  const pr = lane.insert(g)
                  stats()
                  await pr
                }),
              ),
            )
            stats()
          },
        },
        {
          title: 'Merges build a tree of parts',
          body: 'Background threads pick neighbouring parts and <b>merge-sort</b> them into one bigger part, one level higher. Several merges run <b>concurrently</b>; more cores and RAM mean more merge throughput.',
          async run() {
            const [a, b, c, d, e, f] = lane.parts
            totals.merges += 2
            const t1 = world.label('merge thread 1', a.x + PART_PITCH, 1.9, a.z, 'tag cyan', 0)
            const t2 = world.label('merge thread 2', d.x + PART_PITCH, 1.9, d.z, 'tag cyan', 0)
            const m1 = lane.merge([a, b, c], 1700)
            const m2 = tw.wait(250).then(() => lane.merge([d, e, f], 1700))
            stats()
            await all(tw.to([t1, t2], { o: 1 }, { duration: 300 }), fit(ctx, MAIN_DEEP, { theta: -0.14, phi: 0.88, duration: 1500 }), m1, m2)
            await tw.to([t1, t2], { o: 0 }, { duration: 300 })
            world.removeLabel(t1)
            world.removeLabel(t2)
            stats()
          },
        },
        {
          title: 'Inside one merge: four stages',
          body: 'A merge <b>decompresses</b> the source column files into memory, <b>merges</b> them in sort order, builds a new <b>sparse primary index</b>, then <b>compresses</b> and writes everything as a new part directory.',
          hold: 2000,
          async run() {
            totals.merges++
            const pr = lane.mergeStaged(lane.parts.slice(0, 2))
            stats()
            await pr
            stats()
          },
        },
        {
          title: 'Old parts linger, then go',
          body: 'The source parts are now <b>inactive</b>: queries no longer read them, but they stay on disk for about <b>8 minutes</b> before they are deleted. Merging rewrites data; it never edits a part in place.',
          async run() {
            const tag = world.label('inactive · deleted after ~8 min', LANE_X0 + 3, 1.2, LANE_Z0 + 1.4, 'tag', 0)
            await all(tw.to(tag, { o: 1 }, { duration: 400 }), tint(ctx, lane.inactive, P.steel, { a: 0.22, duration: 600 }))
            await tw.wait(1400)
            tag.set('+8 min')
            await all(fade(ctx, lane.inactive, 0, { duration: 1000 }), tw.to(tag, { o: 0 }, { duration: 1000, delay: 400 }))
            cells.release(lane.inactive)
            lane.inactive.length = 0
          },
        },
        {
          title: 'ReplacingMergeTree keeps the latest row',
          body: 'Engine variants change what a merge does with rows that share a sorting key. <code>ReplacingMergeTree</code> keeps only the <b>latest version</b> of each key. Until a merge runs, duplicates can still be read.',
          code: 'ENGINE = ReplacingMergeTree(ver) ORDER BY key',
          async run() {
            await fit(ctx, VARIANTS, { theta: -0.08, phi: 0.86 })
            vtitle('part 1', VX)
            vtitle('part 2', VX + 1.8)
            const p1 = [0, 1, 2, 3].map((k, i) => vrow(k, 1, 1, VX, rz(i), 'replace'))
            const p2 = [1, 3, 4].map((k, i) => vrow(k, 1, 2, VX + 1.8, rz(i), 'replace'))
            await all(
              tw.to([...p1, ...p2].flatMap((r) => [r.k, r.v]), { a: 1 }, { duration: 500, delay: tw.stagger(30) }),
              tw.to([...vlabels, ...vrows.map((r) => r.label)], { o: 1 }, { duration: 500 }),
            )
            await tw.wait(500)
            const n = await variantMerge(p1, p2, 'replace')
            ctx.stats([
              { label: 'Rows before merge', value: 7 },
              { label: 'Rows after merge', value: n, tone: 'volt' },
            ])
          },
        },
        {
          title: 'SummingMergeTree adds them up',
          body: '<code>SummingMergeTree</code> sums the numeric columns of rows with the same key. <code>AggregatingMergeTree</code> generalises this: it merges <b>partial aggregation states</b> of 90+ functions (see the materialized view lessons).',
          code: 'ENGINE = SummingMergeTree ORDER BY key',
          async run() {
            await clearVariants()
            vtitle('part 1', VX)
            vtitle('part 2', VX + 1.8)
            const p1 = [
              [0, 3],
              [1, 2],
              [2, 4],
            ].map(([k, v], i) => vrow(k, v, 1, VX, rz(i), 'sum'))
            const p2 = [
              [1, 1],
              [2, 3],
              [3, 2],
            ].map(([k, v], i) => vrow(k, v, 1, VX + 1.8, rz(i), 'sum'))
            await all(
              tw.to([...p1, ...p2].flatMap((r) => [r.k, r.v]), { a: 1 }, { duration: 500, delay: tw.stagger(30) }),
              tw.to([...vlabels, ...vrows.map((r) => r.label)], { o: 1 }, { duration: 500 }),
            )
            await tw.wait(500)
            const n = await variantMerge(p1, p2, 'sum')
            ctx.stats([
              { label: 'Rows before merge', value: 6 },
              { label: 'Rows after merge', value: n, tone: 'volt' },
            ])
          },
        },
        {
          title: 'Avoid OPTIMIZE FINAL',
          body: '<code>OPTIMIZE TABLE … FINAL</code> forces every part, even huge ones that are already merged, to be <b>rewritten</b> into a single part. That is expensive I/O for little gain. Let background merges do their job.',
          code: 'OPTIMIZE TABLE events FINAL  -- rewrites everything',
          hold: 3600,
          async run() {
            await all(clearVariants(), fit(ctx, { ...MAIN_DEEP, z1: 5.2 }, { theta: -0.12, phi: 0.88, duration: 1200 }))
            totals.inserts += 2
            await all(lane.insert(2), tw.wait(250).then(() => lane.insert(3)))
            stats()
            const warn = world.label('rewrites 100% of the table', LANE_X0 + 3.5, 2.2, LANE_Z0 + 1.5, 'tag coral', 0)
            totals.merges++
            const big = lane.parts.flatMap((p) => p.rows.flatMap((r) => r.cells))
            await all(tw.to(warn, { o: 1 }, { duration: 400 }), tint(ctx, big, (c) => mix([c.r, c.g, c.b], P.coral, 0.35), { duration: 500 }))
            const pr = lane.merge(lane.parts.slice(), 2200)
            await pr
            await all(
              ...lane.parts.map((p) => tint(ctx, p.rows.flatMap((r) => r.cells), (c) => scale(keyColor(p.rows.find((r) => r.cells.includes(c))!.key), COL_DIM[c.data.col]), { duration: 600 })),
              tw.to(warn, { o: 0 }, { duration: 600, delay: 600 }),
            )
            stats([{ label: 'Data rewritten', value: '100%', tone: 'coral' }])
          },
        },
      ],
    }
  },
}
