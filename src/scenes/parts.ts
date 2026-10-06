import type { Cell } from '../engine/Cells'
import type { Label, LineHandle } from '../engine/World'
import { COLUMN_HUES, P, keyColor, mix, scale, type RGB } from '../engine/palette'
import { all, drop, fit, fitRig, rng, setCamera, shuffle, spawn } from './kit'
import type { SceneDef } from './types'

const COLS = ['date', 'town', 'street', 'price']
const TOWNS = ['BRISTOL', 'LEEDS', 'LONDON', 'YORK']
const STREETS = [
  ['BROAD ST', 'CORN ST', 'PARK ROW', 'QUEEN SQ'],
  ['ALBION ST', 'BOAR LANE', 'BRIGGATE', 'PARK LANE'],
  ['BAKER ST', 'FLEET ST', 'OXFORD ST', 'STRAND'],
  ['COPPERGATE', 'MICKLEGATE', 'PETERGATE', 'STONEGATE'],
]
const ROWS = 16
const G = 4 // rows per granule in this drawing (8,192 in reality)
const CPX = 0.5
const RPZ = 0.26
/** how well each column compresses once sorted: town is a long run, price is noisy */
const RATIO = [0.42, 0.14, 0.3, 0.62]
const DIR_X = -0.6
const BAR_X = 0.2
const FILE_ROWS = ['primary.idx', 'date.bin', 'town.bin', 'street.bin', 'price.bin', 'metadata']

interface Row {
  town: number
  street: number
  cells: Cell[]
}

const rowZ = (i: number) => (i - (ROWS - 1) / 2) * RPZ
const fileZ = (i: number) => -2.2 + i * 0.78

export const parts: SceneDef = {
  id: 'parts',
  title: 'Table parts',
  kicker: 'What one INSERT writes to disk',
  blurb: 'An insert is sorted, split into columns, compressed and written as an immutable part directory.',
  docs: 'https://clickhouse.com/docs/concepts/core-concepts/parts',
  create(ctx) {
    const { world, tw, cells } = ctx
    const rand = rng(17)

    const colorOf = (c: number, town: number, street: number): RGB => {
      if (c === 1) return keyColor(town / (TOWNS.length - 1))
      if (c === 2) return mix(keyColor((town + street / 4) / TOWNS.length), P.white, 0.18)
      if (c === 0) return scale(COLUMN_HUES[0], 0.55 + rand() * 0.35)
      return scale(COLUMN_HUES[4], 0.5 + rand() * 0.45)
    }

    // 16 rows of uk_price_paid: four towns, four streets each, arriving in random order
    const sorted: Row[] = []
    for (let t = 0; t < TOWNS.length; t++)
      for (let k = 0; k < 4; k++) {
        const street = Math.floor(rand() * 4)
        sorted.push({ town: t, street, cells: [] })
      }
    sorted.sort((a, b) => a.town - b.town || a.street - b.street)
    const arrival = shuffle(sorted, rand)
    arrival.forEach((r, i) => {
      r.cells = COLS.map((_, c) =>
        spawn(ctx, { x: (c - 1.5) * CPX, z: rowZ(i), w: 0.42, d: 0.2, h: 0.14, color: colorOf(c, r.town, r.street), data: { c } }),
      )
    })
    const allCells = arrival.flatMap((r) => r.cells)

    const colTitles = COLS.map((n, c) => world.label(n, (c - 1.5) * CPX, 0.02, rowZ(0) - 0.4, 'small', 0))
    const orderTag = world.label('<span class="k">ORDER BY</span>(town, street)', 0, 0.02, rowZ(ROWS - 1) + 0.55, 'tag', 0)

    // granule frames + one primary index mark per granule
    const frames: LineHandle[] = Array.from({ length: ROWS / G }, (_, g) =>
      world.rect(0, 0.008, (rowZ(g * G) + rowZ(g * G + G - 1)) / 2, 4 * CPX + 0.12, G * RPZ - 0.04, P.mist, 0),
    )
    const markX = -2.1
    const marks = Array.from({ length: ROWS / G }, (_, g) => {
      const r = sorted[g * G]
      return cells.alloc({ x: markX, y: 0, z: (rowZ(g * G) + rowZ(g * G + G - 1)) / 2, w: 0.2, h: 0.2, d: 0.2, a: 0, color: keyColor(r.town / (TOWNS.length - 1)) })
    })
    const markLabels = marks.map((m, g) => {
      const r = sorted[g * G]
      return world.label(`${TOWNS[r.town]} · ${STREETS[r.town][r.street]}`, markX - 1.45, 0.02, m.z, 'mark', 0)
    })
    const idxTitle = world.label('sparse primary index', markX - 0.2, 0.02, rowZ(0) - 0.4, 'small', 0)

    // the part directory
    const dirFrame = world.rect(DIR_X + 2.55, 0.006, fileZ(2.5), 7.5, 5.2, P.steel, 0, true)
    const dirTitle = world.label('<span class="k">part</span>all_1_1_0/', DIR_X - 0.6, 0.02, fileZ(0) - 0.7, 'tag volt', 0)
    const fileLabels: Label[] = FILE_ROWS.map((n, i) => world.label(n, DIR_X - 0.75, 0.02, fileZ(i), 'small', 0))
    const markFiles: Cell[] = COLS.map((_, c) =>
      cells.alloc({ x: BAR_X + 4.35, y: 0, z: fileZ(c + 1), w: 0.34, h: 0.12, d: 0.3, a: 0, color: P.steel }),
    )
    const markFileLabels = COLS.map((n, c) => world.label(`${n}.mrk2`, BAR_X + 5.1, 0.02, fileZ(c + 1), 'small', 0))
    const meta = ['checksums.txt', 'columns.txt', 'count.txt'].map((n, i) => ({
      cell: cells.alloc({ x: BAR_X + 0.2 + i * 1.75, y: 0, z: fileZ(5), w: 0.24, h: 0.14, d: 0.24, a: 0, color: P.steel }),
      label: world.label(n, BAR_X + 0.95 + i * 1.75, 0.02, fileZ(5), 'small', 0),
    }))

    const TABLE = { x0: -4.4, x1: 1.4, z0: -2.6, z1: 2.6 }
    const SPREAD = { x0: -5.4, x1: 2.6, z0: -2.6, z1: 2.6 }
    const DIR = { x0: -2.2, x1: 6, z0: -3.2, z1: 2.6 }
    setCamera(ctx, fitRig(ctx, TABLE, { theta: -0.05, phi: 0.86 }))

    const spreadX = (c: number) => (c - 1.5) * 1.15
    // more parts in the last steps
    const extra: { frame: LineHandle; label: Label; bars: Cell[] }[] = []

    return {
      steps: [
        {
          title: 'An INSERT arrives in any order',
          body: 'One <code>INSERT</code> brings a block of rows into <code>uk_price_paid</code>. Here 16 rows stand in for thousands: every row has a <b>date</b>, <b>town</b>, <b>street</b> and <b>price</b>.',
          code: 'CREATE TABLE uk_price_paid (date Date, town LowCardinality(String),\n  street LowCardinality(String), price UInt32)\nENGINE = MergeTree ORDER BY (town, street)',
          async run() {
            await all(drop(ctx, allCells, { each: 6, duration: 800 }), tw.to(colTitles, { o: 1 }, { duration: 600, delay: 300 }))
            ctx.stats([
              { label: 'Rows in block', value: ROWS },
              { label: 'Parts on disk', value: 0 },
            ])
          },
        },
        {
          title: '1 · Sort by the sorting key',
          body: 'First the block is sorted by <code>(town, street)</code>. Then a <b>sparse primary index</b> is built: one entry for the first row of every granule (8,192 rows; four in this drawing).',
          async run() {
            await all(
              ...sorted.map((r, i) => tw.to(r.cells, { z: rowZ(i), y: 0 }, { duration: 1100, ease: 'inOutCubic', delay: i * 18 })),
              tw.to(orderTag, { o: 1 }, { duration: 500 }),
            )
            await all(
              ...frames.map((f, g) => tw.to(f, { o: 0.45 }, { duration: 400, delay: g * 120 })),
              tw.to(marks, { a: 1 }, { duration: 500, delay: tw.stagger(120) }),
              tw.to(markLabels, { o: 1 }, { duration: 500, delay: tw.stagger(120) }),
              tw.to(idxTitle, { o: 1 }, { duration: 500 }),
              fit(ctx, TABLE, { theta: -0.08, phi: 0.86 }),
            )
            ctx.stats([
              { label: 'Rows in block', value: ROWS },
              { label: 'Index entries', value: ROWS / G, tone: 'volt' },
            ])
          },
        },
        {
          title: '2 · Split into columns',
          body: 'The sorted block is cut apart column by column. From here on, <b>each column is handled on its own</b>, which is what lets a query later read only the columns it needs.',
          async run() {
            await all(
              tw.to(frames, { o: 0 }, { duration: 300 }),
              tw.to(orderTag, { o: 0 }, { duration: 300 }),
              ...sorted.flatMap((r) => r.cells.map((c, ci) => tw.to(c, { x: spreadX(ci) }, { duration: 900, ease: 'outBack', delay: ci * 90 }))),
              ...colTitles.map((l, ci) => tw.to(l, { x: spreadX(ci) }, { duration: 900, ease: 'outBack', delay: ci * 90 })),
              tw.to(marks, { x: markX - 1.2 }, { duration: 900, ease: 'inOutCubic' }),
              tw.to([...markLabels, idxTitle], { x: (l: Label) => l.x - 1.2 }, { duration: 900, ease: 'inOutCubic' }),
              fit(ctx, SPREAD, { theta: -0.06, phi: 0.86 }),
            )
          },
        },
        {
          title: '3 · Compress each column',
          body: 'Every column is compressed separately. Sorted, repetitive columns like <code>town</code> shrink to almost nothing; noisy ones like <code>price</code> much less.',
          async run() {
            const z0 = rowZ(0) - RPZ / 2
            await all(
              ...sorted.flatMap((r, i) =>
                r.cells.map((c, ci) =>
                  tw.to(c, { d: 0.2 * RATIO[ci], z: z0 + (i + 0.5) * RPZ * RATIO[ci] }, { duration: 1100, ease: 'inOutCubic', delay: ci * 120 }),
                ),
              ),
            )
            ctx.stats([
              { label: 'Uncompressed', value: '100', unit: '%' },
              { label: 'Compressed', value: Math.round((RATIO.reduce((a, b) => a + b, 0) / 4) * 100), unit: '%', tone: 'cyan' },
            ])
          },
        },
        {
          title: '4 · Write a new part directory',
          body: 'The compressed columns, their <b>marks</b> and <code>primary.idx</code> are written to disk as a new directory: the <b>part</b>. Metadata such as checksums, column list and row count sits next to them.',
          async run() {
            const barPitch = (ci: number) => 0.32 * RATIO[ci] * 1.2
            await all(
              tw.to(colTitles, { o: 0 }, { duration: 300 }),
              tw.to([...markLabels, idxTitle], { o: 0 }, { duration: 300 }),
              fit(ctx, DIR, { theta: -0.1, phi: 0.88, duration: 1400 }),
              ...sorted.flatMap((r, i) =>
                r.cells.map((c, ci) =>
                  tw.to(c, { x: BAR_X + (i + 0.5) * barPitch(ci), z: fileZ(ci + 1), w: barPitch(ci) * 0.86, d: 0.36 }, { duration: 1300, ease: 'inOutCubic', delay: i * 20 }),
                ),
              ),
              ...marks.map((m, g) => tw.to(m, { x: BAR_X + 0.13 + g * 0.28, z: fileZ(0), w: 0.2, d: 0.3 }, { duration: 1300, ease: 'inOutCubic', delay: g * 60 })),
            )
            await all(
              tw.to(dirFrame, { o: 0.7 }, { duration: 500 }),
              tw.to(dirTitle, { o: 1 }, { duration: 500 }),
              tw.to(fileLabels, { o: 1 }, { duration: 500, delay: tw.stagger(80) }),
              tw.to(markFiles, { a: 1 }, { duration: 500, delay: tw.stagger(80) }),
              tw.to(markFileLabels, { o: 1 }, { duration: 500, delay: tw.stagger(80) }),
              tw.to(meta.map((m) => m.cell), { a: 1 }, { duration: 500, delay: tw.stagger(100) }),
              tw.to(meta.map((m) => m.label), { o: 1 }, { duration: 500, delay: tw.stagger(100) }),
            )
            ctx.stats([
              { label: 'Parts on disk', value: 1, tone: 'volt' },
              { label: 'Rows', value: ROWS },
              { label: 'Granules', value: ROWS / G },
            ])
          },
        },
        {
          title: 'Every INSERT writes another part',
          body: 'Parts are <b>immutable</b>: nothing is appended to <code>all_1_1_0</code>. The next inserts become <code>all_2_2_0</code>, <code>all_3_3_0</code>… named <em>partition_minBlock_maxBlock_level</em>.',
          async run() {
            const W = 3.9
            const shift = -3.4
            const ownCells = [...allCells, ...marks, ...markFiles, ...meta.map((m) => m.cell)]
            const ownLabels = [...fileLabels, ...markFileLabels, ...meta.map((m) => m.label), dirTitle]
            const dirLabelsOut = [...fileLabels, ...markFileLabels, ...meta.map((m) => m.label)]
            await tw.to(dirFrame, { o: 0 }, { duration: 250 })
            dirFrame.obj.position.x += shift
            await all(
              tw.to(ownCells, { x: (c: Cell) => c.x + shift }, { duration: 900, ease: 'inOutCubic' }),
              tw.to(ownLabels, { x: (l: Label) => l.x + shift }, { duration: 900, ease: 'inOutCubic' }),
              tw.to(dirLabelsOut, { o: 0.55 }, { duration: 600 }),
              tw.to(dirFrame, { o: 0.5 }, { duration: 600 }),
              fit(ctx, { x0: -5.6, x1: 11, z0: -3.2, z1: 2.6 }, { theta: -0.08, phi: 0.88, duration: 1200 }),
            )
            for (let k = 0; k < 2; k++) {
              const x0 = 3.4 + k * W
              const frame = world.rect(x0 + 1.4, 0.006, fileZ(2.5), 3.3, 5.2, P.steel, 0, true)
              const label = world.label(`all_${k + 2}_${k + 2}_0/`, x0 + 0.3, 0.02, fileZ(0) - 0.7, 'tag', 0)
              const bars: Cell[] = []
              for (let f = 0; f < 6; f++) {
                const len = f === 0 ? 0.9 : f === 5 ? 0.6 : (0.6 + rand() * 1.6) * (f === 2 ? 0.5 : 1)
                bars.push(
                  spawn(ctx, {
                    x: x0 + len / 2,
                    z: fileZ(f),
                    w: len,
                    d: 0.36,
                    h: 0.12,
                    color: f === 0 ? keyColor(0.5) : f === 5 ? P.steel : scale(f === 2 ? keyColor(0.4) : COLUMN_HUES[f === 1 ? 0 : f === 3 ? 2 : 4], 0.75),
                  }),
                )
              }
              extra.push({ frame, label, bars })
              await all(drop(ctx, bars, { each: 50, duration: 700, from: 2 }), tw.to(frame, { o: 0.5 }, { duration: 500 }), tw.to(label, { o: 1 }, { duration: 500 }))
              ctx.stats([
                { label: 'Parts on disk', value: k + 2, tone: 'volt' },
                { label: 'Inserts', value: k + 2 },
              ])
            }
          },
        },
        {
          title: 'Merges come later, so batch your inserts',
          body: 'A background process later merges small parts into bigger ones (see <b>Table part merges</b>). Every insert costs a part, so send <b>~20,000+ rows per insert</b>, or let <code>async_insert</code> batch them on the server.',
          hold: 3600,
          async run() {
            await all(...extra.map((e) => tw.to(e.bars, { glow: 0.3 }, { duration: 300 }).then(() => tw.to(e.bars, { glow: 0 }, { duration: 600 }))))
            ctx.stats([
              { label: 'Parts on disk', value: 3, tone: 'volt' },
              { label: 'Rows per insert', value: '≥ 20K', tone: 'cyan' },
            ])
          },
        },
      ],
    }
  },
}

