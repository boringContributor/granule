import type { Cell } from '../engine/Cells'
import type { Label, LineHandle } from '../engine/World'
import { P, keyColor, mix, scale, type RGB } from '../engine/palette'
import type { ColumnInfo, PartInfo } from '../model/clickhouse'
import { all, fitRig, fmt, fmtBytes, setCamera } from './kit'
import type { Ctx, SceneDef } from './types'

const CPX = 0.3
const GP = 0.2
const PART_GAP = 0.16
const LANE_GAP = 0.9
const MAX_ROWS = 24
const MAX_LANES = 12
const MAX_PARTS_PER_LANE = 28
const MAX_COLS = 8

export interface FeedEvent {
  kind: 'insert' | 'merge' | 'remove'
  text: string
  at: number
}

export interface LiveHighlight {
  readCols: Set<string>
  /** part name → indices of granules that contain matching rows */
  matches: Map<string, Set<number>> | null
}

interface PartView {
  info: PartInfo
  rows: number
  cells: Cell[][]
  label: Label
  x: number
  z: number
}

interface Lane {
  id: string
  label: Label
  outline: LineHandle | null
  more: Label | null
}

const levelColor = (level: number): RGB => (level === 0 ? P.cyan : keyColor(0.42 + Math.min(1, Math.log2(level + 1) / 4) * 0.58))

/**
 * Renders the active parts of a real table and animates the difference between
 * consecutive snapshots of system.parts as inserts, merges and removals.
 */
export class LiveView {
  private ctx: Ctx | null = null
  private views = new Map<string, PartView>()
  private lanes = new Map<string, Lane>()
  private marksPerRow = 1
  private columns: ColumnInfo[] = []
  private highlight: LiveHighlight | null = null
  private parts: PartInfo[] = []
  onEvent: (e: FeedEvent) => void = () => {}

  constructor(
    readonly db: string,
    readonly table: string,
    allColumns: ColumnInfo[],
    readonly granularity: number,
  ) {
    const key = allColumns.filter((c) => c.is_in_sorting_key)
    const rest = allColumns.filter((c) => !c.is_in_sorting_key).sort((a, b) => b.data_compressed_bytes - a.data_compressed_bytes)
    this.columns = [...key, ...rest].slice(0, MAX_COLS)
    // keep table order for readability
    this.columns.sort((a, b) => allColumns.indexOf(a) - allColumns.indexOf(b))
  }

  get shownColumns() {
    return this.columns
  }

  scene(parts: PartInfo[]): SceneDef {
    this.parts = parts
    return {
      id: 'live',
      title: 'Live cluster',
      kicker: `${this.db}.${this.table}`,
      blurb: '',
      create: (ctx) => {
        this.attach(ctx, this.parts)
        return {
          steps: [
            {
              title: `${this.db}.${this.table}`,
              body: '',
              hold: 1e9,
              run: () => new Promise<void>(() => {}),
            },
          ],
        }
      },
    }
  }

  private nCols() {
    return Math.max(1, this.columns.length)
  }

  private rowsOf(p: PartInfo) {
    return Math.max(1, Math.min(MAX_ROWS * 2, Math.ceil(Math.max(1, p.marks - 1) / this.marksPerRow)))
  }

  private visibleParts(parts: PartInfo[]) {
    const byLane = new Map<string, PartInfo[]>()
    for (const p of parts) {
      if (!byLane.has(p.partition_id)) byLane.set(p.partition_id, [])
      byLane.get(p.partition_id)!.push(p)
    }
    const laneIds = [...byLane.keys()].sort().slice(-MAX_LANES)
    const hidden = new Map<string, number>()
    const shown: PartInfo[] = []
    for (const id of laneIds) {
      const list = byLane.get(id)!.sort((a, b) => a.min_block_number - b.min_block_number)
      const keep = list.length > MAX_PARTS_PER_LANE ? list.slice().sort((a, b) => b.rows - a.rows).slice(0, MAX_PARTS_PER_LANE) : list
      const keepSet = new Set(keep)
      shown.push(...list.filter((p) => keepSet.has(p)))
      if (list.length > keep.length) hidden.set(id, list.length - keep.length)
    }
    return { laneIds, shown, hidden, hiddenLanes: byLane.size - laneIds.length }
  }

  private colorFor(p: PartInfo, ci: number): RGB {
    const c = this.columns[ci]
    const base = levelColor(p.level)
    return scale(base, c?.is_in_sorting_key ? 0.95 : 0.66 - (ci % 2) * 0.06)
  }

  /** Compute positions for every visible part. */
  private layout(parts: PartInfo[]) {
    const { laneIds, shown, hidden } = this.visibleParts(parts)
    const laneW = this.nCols() * CPX
    const pos = new Map<string, { x: number; z: number }>()
    const laneDepth = new Map<string, number>()
    laneIds.forEach((id, li) => {
      let z = 0
      const x = (li - (laneIds.length - 1) / 2) * (laneW + LANE_GAP)
      for (const p of shown.filter((q) => q.partition_id === id)) {
        pos.set(p.name, { x, z })
        z += this.rowsOf(p) * GP + PART_GAP
      }
      laneDepth.set(id, z)
    })
    const maxDepth = Math.max(1, ...laneDepth.values())
    for (const v of pos.values()) v.z -= maxDepth / 2
    return { laneIds, shown, hidden, pos, maxDepth, laneW }
  }

  private makeCells(p: PartInfo, x: number, z: number, a: number): Cell[][] {
    const rows = this.rowsOf(p)
    const n = this.nCols()
    return Array.from({ length: rows }, (_, r) =>
      Array.from({ length: n }, (_, ci) =>
        this.ctx!.cells.alloc({
          x: x + (ci - (n - 1) / 2) * CPX,
          z: z + r * GP + GP / 2,
          y: 0,
          w: 0.24,
          d: 0.15,
          h: 0.12,
          a,
          color: this.colorFor(p, ci),
          data: { ci, r },
        }),
      ),
    )
  }

  private partLabel(p: PartInfo) {
    return `${p.name}`
  }

  attach(ctx: Ctx, parts: PartInfo[]) {
    this.ctx = ctx
    this.views.clear()
    this.lanes.clear()
    const maxMarks = Math.max(1, ...parts.map((p) => p.marks))
    this.marksPerRow = Math.max(1, Math.ceil(maxMarks / MAX_ROWS))
    const L = this.layout(parts)
    for (const p of L.shown) {
      const at = L.pos.get(p.name)!
      const cells = this.makeCells(p, at.x, at.z, 1)
      const label = ctx.world.label(this.partLabel(p), at.x, 0.02, at.z - 0.08, 'small', 0)
      this.views.set(p.name, { info: p, rows: cells.length, cells, label, x: at.x, z: at.z })
    }
    this.syncLanes(L, true)
    this.parts = parts
    setCamera(ctx, this.frameFor(L))
    this.applyHighlight(true)
    this.publishStats()
  }

  private frameFor(L: ReturnType<LiveView['layout']>) {
    const half = (L.laneIds.length * (L.laneW + LANE_GAP)) / 2
    return fitRig(this.ctx!, { x0: -half - 0.6, x1: half, z0: -L.maxDepth / 2 - 0.8, z1: L.maxDepth / 2 + 0.3 }, { theta: -0.06, phi: 0.86, min: 7, usable: 0.62 })
  }

  private syncLanes(L: ReturnType<LiveView['layout']>, instant = false) {
    const ctx = this.ctx!
    const seen = new Set<string>()
    L.laneIds.forEach((id, li) => {
      seen.add(id)
      const x = (li - (L.laneIds.length - 1) / 2) * (L.laneW + LANE_GAP)
      let lane = this.lanes.get(id)
      if (!lane) {
        lane = { id, label: ctx.world.label(`<span>${id}</span>`, x - 0.4, 0.02, -L.maxDepth / 2 - 0.45, 'col', 0), outline: null, more: null }
        this.lanes.set(id, lane)
      }
      const hidden = L.hidden.get(id) ?? 0
      if (hidden && !lane.more) lane.more = ctx.world.label('', x, 0.02, L.maxDepth / 2 + 0.3, 'small', 1)
      if (lane.more) lane.more.set(hidden ? `+${hidden} smaller parts` : '')
      const targets: Record<string, number> = { x: x - 0.4, z: -L.maxDepth / 2 - 0.45, o: 1 }
      if (instant) Object.assign(lane.label, targets)
      else ctx.tw.to(lane.label, targets, { duration: 700 }).catch(() => {})
      if (lane.more) Object.assign(lane.more, { x, z: L.maxDepth / 2 + 0.3 })
    })
    for (const [id, lane] of this.lanes) {
      if (seen.has(id)) continue
      ctx.world.removeLabel(lane.label)
      if (lane.more) ctx.world.removeLabel(lane.more)
      this.lanes.delete(id)
    }
  }

  /** Animate from the current snapshot to `next`. */
  async update(next: PartInfo[]) {
    const ctx = this.ctx
    if (!ctx) return
    const { tw, cells, world } = ctx
    const prevByName = new Map(this.parts.map((p) => [p.name, p]))
    const nextNames = new Set(next.map((p) => p.name))
    const removed = this.parts.filter((p) => !nextNames.has(p.name))
    const added = next.filter((p) => !prevByName.has(p.name))
    this.parts = next
    if (!removed.length && !added.length) {
      // row counts of existing parts never change (parts are immutable), nothing to do
      return
    }

    const maxMarks = Math.max(1, ...next.map((p) => p.marks))
    if (Math.ceil(maxMarks / this.marksPerRow) > MAX_ROWS * 2) {
      // the scale no longer fits: rebuild in place
      world.clear()
      this.attach(ctx, next)
      return
    }

    const L = this.layout(next)
    const consumed = new Set<string>()
    const jobs: Promise<unknown>[] = []

    // merges: a new part whose block range covers removed parts of the same partition
    for (const a of added) {
      const sources = removed.filter((r) => r.partition_id === a.partition_id && r.min_block_number >= a.min_block_number && r.max_block_number <= a.max_block_number)
      sources.forEach((s) => consumed.add(s.name))
      const at = L.pos.get(a.name)
      const isMerge = sources.length > 0
      if (isMerge) {
        this.onEvent({
          kind: 'merge',
          text: sources.length > 1 ? `merge ${sources.length} parts → ${a.name}` : `mutate ${sources[0].name} → ${a.name}`,
          at: Date.now(),
        })
      } else {
        this.onEvent({ kind: 'insert', text: `insert ${a.name} · ${fmt(a.rows)} rows`, at: Date.now() })
      }
      if (!at) continue
      const target = this.makeCells(a, at.x, at.z, 0)
      const label = world.label(this.partLabel(a), at.x, 0.02, at.z - 0.08, 'small', 0)
      this.views.set(a.name, { info: a, rows: target.length, cells: target, label, x: at.x, z: at.z })
      const flat = target.flat()
      const srcViews = sources.map((s) => this.views.get(s.name)).filter(Boolean) as PartView[]
      if (srcViews.length) {
        const srcCells = srcViews.flatMap((v) => v.cells.flat())
        srcViews.forEach((v) => {
          this.views.delete(v.info.name)
          jobs.push(tw.to(v.label, { o: 0 }, { duration: 300 }).then(() => world.removeLabel(v.label)))
        })
        // source cells lift and fly into the merged part, then hand over to its cells
        jobs.push(
          (async () => {
            await tw.to(srcCells, { y: 0.9, glow: 0.35 }, { duration: 450, delay: tw.stagger(2), ease: 'outQuad' })
            await all(
              ...srcCells.map((c, i) => {
                const t = flat[i % flat.length]
                return tw.to(c, { x: t.x, z: t.z, w: t.w, d: t.d }, { duration: 900, ease: 'inOutCubic', delay: (i % 40) * 6 })
              }),
            )
            await tw.to(srcCells, { y: 0, glow: 0 }, { duration: 300, ease: 'inQuad' })
            flat.forEach((c) => (c.a = 1))
            cells.release(srcCells)
            await tw.to(label, { o: 1 }, { duration: 400 })
          })(),
        )
      } else {
        // insert: fall in from above
        flat.forEach((c) => (c.y = 2.2))
        jobs.push(all(tw.to(flat, { y: 0, a: 1 }, { duration: 800, ease: 'outExpo', delay: tw.stagger(4) }), tw.to(label, { o: 1 }, { duration: 500, delay: 300 })))
      }
    }

    // removed without a successor (TTL, DROP PARTITION, or simply hidden by the caps)
    for (const r of removed) {
      if (consumed.has(r.name)) continue
      const v = this.views.get(r.name)
      if (!v) continue
      this.views.delete(r.name)
      this.onEvent({ kind: 'remove', text: `remove ${r.name}`, at: Date.now() })
      jobs.push(
        tw
          .to(v.cells.flat(), { a: 0 }, { duration: 600 })
          .then(() => {
            cells.release(v.cells.flat())
            world.removeLabel(v.label)
          }),
      )
    }

    // everybody else slides to their new place; parts that fell off the caps disappear
    for (const [name, v] of this.views) {
      const at = L.pos.get(name)
      if (!at) {
        this.views.delete(name)
        cells.release(v.cells.flat())
        world.removeLabel(v.label)
        continue
      }
      if (added.some((a) => a.name === name)) continue
      if (Math.abs(at.x - v.x) < 1e-3 && Math.abs(at.z - v.z) < 1e-3) continue
      const dx = at.x - v.x
      const dz = at.z - v.z
      v.x = at.x
      v.z = at.z
      jobs.push(tw.to(v.cells.flat(), { x: (c: Cell) => c.x + dx, z: (c: Cell) => c.z + dz }, { duration: 700, ease: 'inOutCubic' }))
      jobs.push(tw.to(v.label, { x: at.x, z: at.z - 0.08 }, { duration: 700, ease: 'inOutCubic' }))
    }
    this.syncLanes(L)
    this.publishStats()
    // re-frame when the table outgrows (or shrinks well inside) the view
    const want = this.frameFor(L)
    const rig = ctx.world.rig
    if (Math.abs((want.radius ?? rig.radius) - rig.radius) / rig.radius > 0.12 || Math.abs((want.tz ?? 0) - rig.tz) > 1) {
      jobs.push(ctx.tw.to(rig, { radius: want.radius!, tx: want.tx!, tz: want.tz! }, { duration: 1400, ease: 'inOutQuart' }))
    }
    await all(...jobs).catch(() => {})
    this.applyHighlight()
  }

  /** Visualize what a query reads; pass null to clear. */
  setHighlight(h: LiveHighlight | null) {
    this.highlight = h
    this.applyHighlight()
  }

  private applyHighlight(instant = false) {
    const ctx = this.ctx
    if (!ctx) return
    const h = this.highlight
    const jobs: Promise<unknown>[] = []
    for (const v of this.views.values()) {
      const matched = h?.matches?.get(v.info.name)
      v.cells.forEach((row, r) =>
        row.forEach((c, ci) => {
          const col = this.columns[ci]
          const base = this.colorFor(v.info, ci)
          let target = { r: base[0], g: base[1], b: base[2], a: 1, glow: 0 }
          if (h) {
            const colRead = h.readCols.size === 0 || h.readCols.has(col?.name)
            let granuleHit = true
            if (h.matches) {
              granuleHit = false
              if (matched) {
                const g0 = r * this.marksPerRow
                for (let g = g0; g < g0 + this.marksPerRow; g++) if (matched.has(g)) granuleHit = true
              }
            }
            if (!colRead || !granuleHit) {
              const m = mix(P.slate, base, 0.25)
              target = { r: m[0], g: m[1], b: m[2], a: colRead ? 0.16 : 0.07, glow: 0 }
            } else target.glow = 0.45
          }
          if (instant) Object.assign(c, target)
          else jobs.push(ctx.tw.to(c, target, { duration: 500 }))
        }),
      )
    }
    return all(...jobs).catch(() => {})
  }

  publishStats() {
    const ctx = this.ctx
    if (!ctx) return
    const parts = this.parts
    const rows = parts.reduce((s, p) => s + p.rows, 0)
    const bytes = parts.reduce((s, p) => s + p.bytes_on_disk, 0)
    const partitions = new Set(parts.map((p) => p.partition_id)).size
    const maxLevel = Math.max(0, ...parts.map((p) => p.level))
    ctx.stats([
      { label: 'Active parts', value: parts.length, tone: parts.length > 300 ? 'coral' : 'volt' },
      { label: 'Partitions', value: partitions },
      { label: 'Rows', value: fmt(rows) },
      { label: 'On disk', value: fmtBytes(bytes), tone: 'cyan' },
      { label: 'Max merge level', value: maxLevel, tone: 'violet' },
    ])
  }
}

export const LEVEL_LEGEND = [0, 1, 3, 8, 20].map((l) => ({ level: l, color: levelColor(l) }))

/** Shown before a table is picked: a quiet field of empty granules breathing in a slow wave. */
export const liveIdleScene: SceneDef = {
  id: 'live-idle',
  title: 'Live cluster',
  kicker: '',
  blurb: '',
  create(ctx) {
    const cells: Cell[] = []
    for (let x = 0; x < 18; x++)
      for (let z = 0; z < 10; z++)
        cells.push(ctx.cells.alloc({ x: (x - 8.5) * 0.5, z: (z - 4.5) * 0.4, w: 0.36, d: 0.26, h: 0.1, a: 0.12, color: P.steel, data: { x, z } }))
    ctx.world.onTick((t) => {
      for (const c of cells) {
        const w = Math.sin(t * 1.4 - c.data.x * 0.45 - c.data.z * 0.3)
        c.a = 0.1 + Math.max(0, w) * 0.22
        c.glow = Math.max(0, w - 0.85) * 2
        c.r = P.steel[0] + (P.cyan[0] - P.steel[0]) * Math.max(0, w) * 0.4
        c.g = P.steel[1] + (P.cyan[1] - P.steel[1]) * Math.max(0, w) * 0.4
        c.b = P.steel[2] + (P.cyan[2] - P.steel[2]) * Math.max(0, w) * 0.4
      }
    })
    setCamera(ctx, { tx: 0, ty: 0, tz: 0, theta: -0.2, phi: 0.9, radius: 13 })
    ctx.stats(null)
    return { steps: [{ title: 'Live cluster', body: '', hold: 1e9, run: () => new Promise<void>(() => {}) }] }
  },
}
