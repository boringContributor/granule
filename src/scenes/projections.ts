import type { Cell } from '../engine/Cells'
import { COLUMN_HUES, P, keyColor, mix, scale, type RGB } from '../engine/palette'
import { all, drop, fade, fit, fitRig, rng, setCamera, spawn, tint } from './kit'
import type { SceneDef } from './types'

const PARTS = 3
const G = 10
const GPX = 0.32
const PART_X = (p: number) => (p - (PARTS - 1) / 2) * 4.3
const xAt = (p: number, g: number) => PART_X(p) + (g - (G - 1) / 2) * GPX
const COUNTIES = 6
const TARGET = 2
const COUNTY_COLORS: RGB[] = [COLUMN_HUES[0], COLUMN_HUES[2], COLUMN_HUES[4], COLUMN_HUES[3], COLUMN_HUES[5], COLUMN_HUES[6]]
// rows (z) of the base table and of the projection's hidden table
const BASE_Z = { town: 0.55, county: 0.92, price: 1.29 }
const PROJ_Z = { county: -1.05, town: -0.68, price: -0.31 }
const AGG_Z = -2.05

interface Granule {
  town: number
  county: number
  price: number
}

export const projections: SceneDef = {
  id: 'projections',
  title: 'Projections',
  kicker: 'A second sort order inside each part',
  blurb: 'A projection is a hidden, differently sorted copy of the data stored inside every part.',
  docs: 'https://clickhouse.com/docs/concepts/features/projections/projections',
  create(ctx) {
    const { world, tw, cells } = ctx
    const rand = rng(8)

    const data: Granule[][] = Array.from({ length: PARTS }, () => {
      const towns = Array.from({ length: G }, () => rand()).sort((a, b) => a - b)
      const counties = Array.from({ length: G }, (_, g) => (g % 4 === 1 ? TARGET : Math.floor(rand() * COUNTIES)))
      return towns.map((town, g) => ({ town, county: counties[g], price: 0.2 + rand() * 0.8 }))
    })
    const priceColor = (v: number) => scale(COLUMN_HUES[1], 0.4 + v * 0.45)

    const cell = (x: number, z: number, color: RGB, data: object) => spawn(ctx, { x, z, w: 0.25, d: 0.27, h: 0.14, color, data: { ...data, orig: color } })
    const base = data.map((part, p) =>
      part.map((gr, g) => ({
        town: cell(xAt(p, g), BASE_Z.town, keyColor(gr.town), { p, g }),
        county: cell(xAt(p, g), BASE_Z.county, COUNTY_COLORS[gr.county], { p, g, hit: gr.county === TARGET }),
        price: cell(xAt(p, g), BASE_Z.price, priceColor(gr.price), { p, g }),
      })),
    )
    const baseCells = base.flatMap((part) => part.flatMap((r) => [r.town, r.county, r.price]))

    // the projection: the same granules, re-sorted by county
    const order = data.map((part) => part.map((_, g) => g).sort((a, b) => part[a].county - part[b].county || part[a].town - part[b].town))
    const proj = data.map((part, p) =>
      order[p].map((src, slot) => {
        const gr = part[src]
        const mk = (row: 'town' | 'county' | 'price', color: RGB) =>
          cells.alloc({ x: xAt(p, src), y: 0, z: BASE_Z[row], w: 0.25, d: 0.27, h: 0.14, a: 0, color, data: { p, slot, row, hit: gr.county === TARGET, orig: color } })
        return { county: mk('county', COUNTY_COLORS[gr.county]), town: mk('town', keyColor(gr.town)), price: mk('price', priceColor(gr.price)) }
      }),
    )
    const projCells = proj.flatMap((part) => part.flatMap((r) => [r.county, r.town, r.price]))

    // aggregate projection: one row per county per part (pre-aggregated avg(price))
    const agg = Array.from({ length: PARTS }, (_, p) =>
      Array.from({ length: COUNTIES }, (_, k) =>
        cells.alloc({ x: PART_X(p) + (k - (COUNTIES - 1) / 2) * 0.42, y: 0, z: AGG_Z, w: 0.3, d: 0.3, h: 0.02, a: 0, color: COUNTY_COLORS[k], data: { p, k } }),
      ),
    ).flat()

    const left = xAt(0, 0) - 0.3
    const rowLabel = (html: string, z: number) => world.label(`<span style="display:inline-block;transform:translateX(-50%)">${html}</span>`, left, 0.02, z, 'small', 0)
    const baseLabels = [rowLabel('town <span class="k">sort key</span>', BASE_Z.town), rowLabel('county', BASE_Z.county), rowLabel('price', BASE_Z.price)]
    const projLabels = [rowLabel('county <span class="k">projection key</span>', PROJ_Z.county), rowLabel('town', PROJ_Z.town), rowLabel('price', PROJ_Z.price)]
    const aggLabel = rowLabel('avg(price) <span class="k">by county</span>', AGG_Z)
    const partLabels = Array.from({ length: PARTS }, (_, p) => world.label(`<span class="k">part</span>${p + 1}`, PART_X(p), 0.02, BASE_Z.price + 0.5, 'tag', 0))
    const projTitle = world.label('<span class="k">hidden table</span>by_county · ORDER BY county', PART_X(1), 0.02, PROJ_Z.county - 0.5, 'tag violet', 0)
    const aggTitle = world.label('<span class="k">hidden AggregatingMergeTree</span>avg_by_county', PART_X(1), 0.02, AGG_Z - 1.05, 'tag violet', 0)

    const ghost = (list: Cell[], a = 0.1, d = 500) => tint(ctx, list, (c) => mix(P.slate, [c.r, c.g, c.b], 0.25), { a, glow: 0, duration: d })

    const BASE_BOX = { x0: left - 2, x1: xAt(PARTS - 1, G - 1) + 0.4, z0: -0.4, z1: BASE_Z.price + 0.8 }
    const FULL_BOX = { x0: left - 2, x1: xAt(PARTS - 1, G - 1) + 0.4, z0: AGG_Z - 1.4, z1: BASE_Z.price + 0.8 }
    setCamera(ctx, fitRig(ctx, BASE_BOX, { theta: -0.04, phi: 0.84, pad: 0.86 }))

    return {
      steps: [
        {
          title: 'A table sorted by town',
          body: 'Each part is sorted by <code>town</code>, so <code>town</code> reads as a smooth ramp while <code>county</code> is scattered. Every box is one granule of one column.',
          code: 'CREATE TABLE uk_price_paid (town String, county String, price UInt32, …)\nENGINE = MergeTree ORDER BY (town, street)',
          async run() {
            await all(
              ...base.map((part, p) => tw.wait(p * 180).then(() => drop(ctx, part.flatMap((r) => [r.town, r.county, r.price]), { each: 4, duration: 700 }))),
              tw.to([...baseLabels, ...partLabels], { o: 1 }, { duration: 600, delay: 300 }),
            )
            ctx.stats([
              { label: 'Rows (docs dataset)', value: '30.03M' },
              { label: 'Parts', value: PARTS, unit: ' shown' },
            ])
          },
        },
        {
          title: 'Filtering by county reads everything',
          body: 'The primary index only knows <code>town</code>. Rows for one county could be in any granule, so the whole table is scanned.',
          code: "SELECT town, price FROM uk_price_paid WHERE county = 'WEST MIDLANDS'",
          async run() {
            const hits = baseCells.filter((c) => c.data.hit)
            await tw.to(hits, { glow: 0.3, y: 0.08 }, { duration: 400, delay: tw.stagger(40) })
            await tw.to(baseCells, { glow: 0.16 }, { duration: 300, delay: (c: Cell) => c.data.g * 30 + c.data.p * 120 })
            await tw.to(baseCells, { glow: 0, y: 0 }, { duration: 500 })
            ctx.stats([{ label: 'Rows read (docs)', value: '30.03M', of: '30.03M', tone: 'coral', meter: 1 }])
          },
        },
        {
          title: 'A projection stores a second sort order',
          body: 'A projection is a hidden table inside every part, with its own sort order and primary index. ClickHouse writes it on every insert, so the data is stored twice but stays in sync automatically.',
          code: 'ALTER TABLE uk_price_paid ADD PROJECTION by_county (SELECT * ORDER BY county);\nALTER TABLE uk_price_paid MATERIALIZE PROJECTION by_county;',
          async run() {
            await fit(ctx, FULL_BOX, { theta: -0.08, phi: 0.86, pad: 0.88, duration: 1400 })
            const moves = proj.flatMap((part, p) =>
              part.flatMap((r, slot) =>
                (['county', 'town', 'price'] as const).map((row) => {
                  const c = r[row]
                  return tw
                    .to(c, { a: 1, y: 0.7 }, { duration: 300, delay: p * 160 + slot * 25 })
                    .then(() => tw.to(c, { x: xAt(p, slot), z: PROJ_Z[row] }, { duration: 900, ease: 'inOutCubic' }))
                    .then(() => tw.to(c, { y: 0 }, { duration: 300, ease: 'inQuad' }))
                }),
              ),
            )
            await all(...moves, tw.to([...projLabels, projTitle], { o: 1 }, { duration: 600, delay: 900 }))
            ctx.stats([
              { label: 'Copies of the data', value: 2, tone: 'coral' },
              { label: 'Kept in sync', value: 'on insert', tone: 'cyan' },
            ])
          },
        },
        {
          title: 'The query now reads the projection',
          body: 'At query time ClickHouse compares the table and its projections and reads whichever needs the least data. Sorted by county, the matching rows sit together: 2.17M rows read instead of 30.03M in the docs example.',
          code: "SELECT town, price FROM uk_price_paid WHERE county = 'WEST MIDLANDS'",
          hold: 3200,
          async run() {
            await ghost(baseCells, 0.2, 600)
            const miss = projCells.filter((c) => !c.data.hit)
            const hit = projCells.filter((c) => c.data.hit)
            await all(ghost(miss, 0.12, 600), tw.to(hit, { glow: 0.4, y: 0.06 }, { duration: 500, delay: tw.stagger(20) }))
            await tw.to(hit, { glow: 0.2 }, { duration: 400 })
            ctx.stats([
              { label: 'Rows read (docs)', value: '2.17M', of: '30.03M', tone: 'volt', meter: 2.17 / 30.03 },
              { label: 'Read from', value: 'by_county', tone: 'violet' },
            ])
          },
        },
        {
          title: 'Aggregate projections pre-compute results',
          body: 'With a <code>GROUP BY</code>, the hidden table becomes an AggregatingMergeTree holding partial aggregates. The average price per county is then answered from 132 pre-aggregated rows in the docs example.',
          code: 'ALTER TABLE uk_price_paid ADD PROJECTION avg_by_county\n  (SELECT county, avg(price) GROUP BY county);\n\nSELECT county, avg(price) FROM uk_price_paid GROUP BY county',
          hold: 3200,
          async run() {
            await all(ghost(projCells, 0.15, 500), tw.to([aggLabel, aggTitle], { o: 1 }, { duration: 500 }))
            await tw.to(agg, { a: 1 }, { duration: 300, delay: tw.stagger(30) })
            await tw.to(agg, { h: (c: Cell) => 0.15 + ((c.data.k * 37 + c.data.p * 11) % 9) * 0.07, glow: 0.35 }, { duration: 800, ease: 'outBack', delay: tw.stagger(40) })
            await tw.to(agg, { glow: 0.15 }, { duration: 400 })
            ctx.stats([
              { label: 'Rows read (docs)', value: 132, tone: 'volt', meter: 0.01 },
              { label: 'Read from', value: 'avg_by_county', tone: 'violet' },
            ])
          },
        },
        {
          title: 'The cost: storage and insert work',
          body: 'Every projection adds storage and makes each insert write more. Since 25.5, lightweight projections can store just the sort key plus <code>_part_offset</code>, acting like an index that points back into the base rows.',
          hold: 3600,
          async run() {
            const projOthers = projCells.filter((c) => c.data.row !== 'county')
            await all(
              tint(ctx, baseCells, (c) => c.data.orig, { a: 1, duration: 600 }),
              tint(ctx, projCells.filter((c) => c.data.row === 'county'), (c) => c.data.orig, { a: 1, glow: 0, duration: 600 }),
              tw.to(projCells, { y: 0 }, { duration: 400 }),
              fade(ctx, projOthers, 0.06, { duration: 600, glow: 0 }),
              tw.to(projLabels.slice(1), { o: 0.3 }, { duration: 500 }),
              tw.to(agg, { glow: 0 }, { duration: 400 }),
            )
            ctx.stats([
              { label: 'Full projection', value: '+1 copy', tone: 'coral' },
              { label: 'Lightweight (25.5+)', value: 'key + offset', tone: 'cyan' },
            ])
          },
        },
      ],
    }
  },
}
