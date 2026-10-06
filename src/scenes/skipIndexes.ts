import type { Cell } from '../engine/Cells'
import type { Label } from '../engine/World'
import { COLUMN_HUES, P, keyColor, mix, scale } from '../engine/palette'
import { all, drop, fit, fitRig, rng, setCamera, spawn, tint } from './kit'
import type { SceneDef, Stat } from './types'

const G = 32
const PER = 4 // GRANULARITY 4
const BLOCKS = G / PER
const GPX = 0.3
const xAt = (g: number) => (g - (G - 1) / 2) * GPX + (Math.floor(g / PER) - (BLOCKS - 1) / 2) * 0.2
const blockX = (b: number) => (xAt(b * PER) + xAt(b * PER + PER - 1)) / 2

interface Table {
  name: string
  note: string
  z: number
  ts: Cell[]
  code: Cell[]
  tokens: Cell[]
  /** which status codes each block's index entry holds */
  sets: number[][]
  title: Label
}

export const skipIndexes: SceneDef = {
  id: 'skipping-indexes',
  title: 'Data skipping indexes',
  kicker: 'Summaries over blocks of granules',
  blurb: 'A skip index stores one summary per block of granules and skips blocks that cannot match.',
  docs: 'https://clickhouse.com/docs/concepts/features/performance/skip-indexes/skipping-indexes',
  create(ctx) {
    const { world, tw } = ctx
    const rand = rng(503)

    const makeTable = (name: string, note: string, z: number, hits: number[]): Table => {
      const ts = Array.from({ length: G }, (_, g) => spawn(ctx, { x: xAt(g), z, w: 0.22, d: 0.26, h: 0.12, color: keyColor(g / (G - 1)), data: { g } }))
      const code = Array.from({ length: G }, (_, g) =>
        spawn(ctx, {
          x: xAt(g),
          z: z + 0.42,
          w: 0.22,
          d: 0.36,
          h: 0.14,
          color: hits.includes(g) ? P.coral : mix(scale(COLUMN_HUES[1], 0.6), P.steel, rand() * 0.6),
          data: { g, hit: hits.includes(g) },
        }),
      )
      const tokens = Array.from({ length: BLOCKS }, (_, b) =>
        ctx.cells.alloc({ x: blockX(b), y: 0, z: z - 0.55, w: PER * GPX - 0.08, d: 0.24, h: 0.1, a: 0, color: P.violet, data: { b } }),
      )
      const sets = Array.from({ length: BLOCKS }, (_, b) => {
        const s = [200]
        if (rand() > 0.35) s.push(404)
        if (hits.some((h) => Math.floor(h / PER) === b)) s.push(503)
        return s
      })
      const title = world.label(`<span class="k">${name}</span>${note}`, xAt(0) + 1.4, 0.02, z - 1.7, 'tag', 0)
      return { name, note, z, ts, code, tokens, sets, title }
    }

    // A: errors arrive in one burst (clustered in time = in sort order). B: errors everywhere.
    const A = makeTable('logs_burst', 'errors come in bursts', -1.7, [21, 22])
    const B = makeTable('logs_spread', 'errors spread evenly', 1.75, Array.from({ length: BLOCKS }, (_, b) => b * PER + Math.floor(rand() * PER)))
    const tables = [A, B]
    const tokenLabels = A.sets.map((s, b) => world.label(`{${s.join(',')}}`, blockX(b), 0.32, A.z - 0.55, 'small', 0))
    const rowLabels = tables.flatMap((t) => [
      world.label('<span style="display:inline-block;transform:translateX(-50%)">ts <span class="k">sort key</span></span>', xAt(0) - 0.3, 0.02, t.z, 'small', 0),
      world.label('<span style="display:inline-block;transform:translateX(-50%)">error_code</span>', xAt(0) - 0.3, 0.02, t.z + 0.42, 'small', 0),
      world.label('<span style="display:inline-block;transform:translateX(-50%)">skip index</span>', xAt(0) - 0.3, 0.02, t.z - 0.55, 'small', 0),
    ])
    const idxRowLabels = [rowLabels[2], rowLabels[5]]

    const ghost = (cells: Cell[], d = 400) => tint(ctx, cells, (c) => mix(P.slate, [c.r, c.g, c.b], 0.25), { a: 0.1, glow: 0, duration: d })
    const blockCells = (t: Table, b: number) => [...t.ts, ...t.code].filter((c) => Math.floor(c.data.g / PER) === b)

    const BOX = { x0: xAt(0) - 2.2, x1: xAt(G - 1) + 0.6, z0: A.z - 1.9, z1: B.z + 0.8 }
    setCamera(ctx, fitRig(ctx, BOX, { theta: -0.04, phi: 0.82, pad: 0.88 }))

    const readStats = (a: number, b: number): Stat[] => [
      { label: `${A.name} · granules read`, value: a, of: G, tone: a < G ? 'volt' : 'coral', meter: a / G },
      { label: `${B.name} · granules read`, value: b, of: G, tone: b < G ? 'volt' : 'coral', meter: b / G },
    ]

    /** Check each index entry left to right; skip blocks without 503. */
    const scan = async (t: Table) => {
      for (let b = 0; b < BLOCKS; b++) {
        const tok = t.tokens[b]
        const may = t.sets[b].includes(503)
        await tw.to(tok, { glow: 0.35, y: 0.12 }, { duration: 160 })
        if (may) {
          await all(
            tint(ctx, [tok], mix(P.volt, P.slate, 0.35), { glow: 0.08, duration: 200 }),
            tw.to(blockCells(t, b), { glow: 0.15, y: 0.05 }, { duration: 250 }),
          )
        } else {
          await all(ghost([tok], 250), ghost(blockCells(t, b), 300))
        }
        await tw.to(tok, { y: 0 }, { duration: 120 })
      }
    }

    return {
      steps: [
        {
          title: 'A filter the primary key can’t help with',
          body: 'Both tables are sorted by <code>ts</code>. The query filters on <code>error_code</code>, which isn’t in the sort key, so the primary index can’t exclude anything and every granule is read.',
          code: 'SELECT count() FROM logs WHERE error_code = 503',
          async run() {
            await all(
              ...tables.map((t, i) => tw.wait(i * 200).then(() => drop(ctx, [...t.ts, ...t.code], { each: 2, duration: 700 }))),
              tw.to([...tables.map((t) => t.title), ...rowLabels.filter((l) => !idxRowLabels.includes(l))], { o: 1 }, { duration: 600, delay: 300 }),
            )
            const codes = tables.flatMap((t) => t.code)
            await tw.to(codes, { glow: 0.35 }, { duration: 300, delay: (c: Cell) => c.data.g * 20 })
            await tw.to(codes, { glow: 0 }, { duration: 400 })
            ctx.stats(readStats(G, G))
          },
        },
        {
          title: 'A skip index summarizes blocks of granules',
          body: 'With <code>GRANULARITY 4</code>, the index stores one summary for every 4 granules: 4 × 8,192 = 32,768 rows. A <code>set</code> index keeps the distinct values seen in that block.',
          code: 'ALTER TABLE logs ADD INDEX idx_code error_code TYPE set(100) GRANULARITY 4;\nALTER TABLE logs MATERIALIZE INDEX idx_code;',
          async run() {
            await all(
              ...tables.flatMap((t) => t.tokens.map((tok, b) => tw.to(tok, { a: 1 }, { duration: 400, delay: b * 70 }))),
              tw.to([...tokenLabels, ...idxRowLabels], { o: 1 }, { duration: 500, delay: tw.stagger(60) }),
              ...tables.flatMap((t) => t.tokens.map((_, b) => tw.to(blockCells(t, b), { glow: 0.25 }, { duration: 200, delay: b * 70 }).then(() => tw.to(blockCells(t, b), { glow: 0 }, { duration: 300 })))),
            )
            ctx.stats([
              { label: 'Index entries per table', value: BLOCKS, tone: 'violet' },
              { label: 'Rows per entry', value: PER * 8192 },
            ])
          },
        },
        {
          title: 'Clustered values: most blocks are skipped',
          body: 'In <code>logs_burst</code> the 503s all happened during one incident, so they sit in one block. Every other index entry proves its block has no 503, and those granules are never read.',
          async run() {
            await scan(A)
            const read = A.sets.filter((s) => s.includes(503)).length * PER
            ctx.stats([...readStats(read, G), { label: 'Docs example', value: '32.7K', of: '100M rows', tone: 'cyan' }])
          },
        },
        {
          title: 'Scattered values: nothing to skip',
          body: 'In <code>logs_spread</code> a 503 shows up in every block, so every index entry says “maybe” and all granules are read anyway. The index now only costs time and space.',
          hold: 3000,
          async run() {
            await scan(B)
            const readA = A.sets.filter((s) => s.includes(503)).length * PER
            ctx.stats(readStats(readA, G))
          },
        },
        {
          title: 'Pick the index type for the data',
          body: '<code>minmax</code> suits loosely sorted values, <code>set(N)</code> few distinct values per block, <code>bloom_filter</code> large value sets and arrays, and the <code>text</code> index full-text search. All of them need values grouped by the sort order to skip much.',
          code: "INDEX i1 ts_ms TYPE minmax GRANULARITY 4\nINDEX i2 error_code TYPE set(100) GRANULARITY 4\nINDEX i3 trace_id TYPE bloom_filter(0.01) GRANULARITY 4\n-- full-text search on message: use the text (inverted) index",
          hold: 4200,
          async run() {
            await fit(ctx, BOX, { theta: -0.12, phi: 0.86, pad: 0.88, duration: 1600 })
          },
        },
      ],
    }
  },
}
