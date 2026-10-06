import type { Cell } from '../engine/Cells'
import type { LineHandle } from '../engine/World'
import { P, keyColor, mix } from '../engine/palette'
import { all, drop, fit, fitRig, rng, setCamera, shuffle, spawn, tint } from './kit'
import type { SceneDef } from './types'

const GRANULES = 16
const PER = 12
const USERS = 12
const TARGET = 7
const XP = 0.26
const ZP = 0.34
const BOX = { x0: -6, x1: 6.2, z0: -3.4, z1: 3 }

interface Table {
  title: string
  x: number
  rows: Cell[][] // [granule][row]
  frames: LineHandle[]
}

export const orderBy: SceneDef = {
  id: 'primary-key',
  title: 'Choosing a primary key',
  docs: 'https://clickhouse.com/docs/concepts/best-practices/choosing-a-primary-key',
  kicker: 'Sorting decides what you skip',
  blurb: 'The same query reads 2 granules or 11 depending on the table’s sort key.',
  create(ctx) {
    const { world, tw } = ctx
    const rand = rng(11)
    const ids = Array.from({ length: GRANULES * PER }, (_, i) => i % USERS)
    const orders = [shuffle(ids, rand), ids.slice().sort((a, b) => a - b)]
    const titles = ['ORDER BY ts', 'ORDER BY user_id']

    const tables: Table[] = orders.map((vals, t) => {
      const x = t === 0 ? -4.1 : 4.1
      const rows = Array.from({ length: GRANULES }, (_, g) =>
        Array.from({ length: PER }, (_, r) => {
          const v = vals[g * PER + r]
          return spawn(ctx, {
            x: x + (r - (PER - 1) / 2) * XP,
            z: (g - (GRANULES - 1) / 2) * ZP,
            w: 0.21,
            d: 0.25,
            h: 0.16,
            color: keyColor(v / (USERS - 1)),
            data: { v, g },
          })
        }),
      )
      const frames = rows.map((_, g) => world.rect(x, 0.01, (g - (GRANULES - 1) / 2) * ZP, PER * XP + 0.06, ZP - 0.04, P.mist, 0))
      return { title: titles[t], x, rows, frames }
    })
    const labels = tables.map((t) => world.label(`<span class="k">${t.title.split(' BY ')[0]} BY</span>${t.title.split(' BY ')[1]}`, t.x, 0.02, -(GRANULES / 2) * ZP - 0.45, 'tag'))
    const granuleNote = world.label('← 1 granule ≈ 8,192 rows', tables[0].x + (PER * XP) / 2 + 1.25, 0.02, -(GRANULES / 2 - 0.5) * ZP, 'small')

    const hit = tables.map((t) => t.rows.map((g) => g.some((c) => c.data.v === TARGET)))
    const hitCount = hit.map((h) => h.filter(Boolean).length)

    setCamera(ctx, fitRig(ctx, BOX, { theta: 0, phi: 0.8 }))

    return {
      steps: [
        {
          title: 'Same rows, two sort orders',
          body: 'Both tables hold identical rows, colored by <code>user_id</code>. On the left they are sorted by time, so users are scattered. On the right they are sorted by <code>user_id</code>.',
          async run() {
            await all(
              tw.to(labels, { o: 1 }, { duration: 600 }),
              fit(ctx, BOX, { theta: -0.06, phi: 0.82, duration: 2200 }),
              ...tables.map((t, i) => tw.wait(i * 250).then(() => drop(ctx, t.rows.flat(), { each: 3, duration: 700, from: 2 }))),
            )
          },
        },
        {
          title: 'Rows are stored in granules',
          body: 'ClickHouse cuts each sorted column into <b>granules</b> of 8,192 rows. A granule is the smallest unit it reads, so skipping happens a granule at a time.',
          async run() {
            await all(
              ...tables.flatMap((t) => t.frames.map((f, g) => tw.to(f, { o: 0.35 }, { duration: 400, delay: g * 30 }))),
              tw.to(granuleNote, { o: 1 }, { duration: 500 }),
            )
            ctx.stats([
              { label: 'Granules per table', value: GRANULES },
              { label: 'Rows per user', value: (GRANULES * PER) / USERS },
            ])
          },
        },
        {
          title: 'Look for one user',
          body: 'The query wants the rows of a single user. On the right they sit together; on the left they are spread across the whole table.',
          code: 'SELECT count() FROM events WHERE user_id = 7',
          async run() {
            const cells = tables.flatMap((t) => t.rows.flat())
            const miss = cells.filter((c) => c.data.v !== TARGET)
            const match = cells.filter((c) => c.data.v === TARGET)
            await all(
              tint(ctx, miss, (c) => mix(P.slate, [c.r, c.g, c.b], 0.3), { a: 0.22, duration: 700 }),
              tw.to(match, { glow: 0.28, y: 0.1 }, { duration: 700, delay: tw.stagger(12) }),
            )
          },
        },
        {
          title: 'Every granule with a match must be read',
          body: 'The primary index only knows each granule’s first key. Sorted by <code>user_id</code>, it can jump straight to the right granules. Sorted by time, almost every granule might contain user 7.',
          hold: 3200,
          async run() {
            const jobs: Promise<void>[] = []
            tables.forEach((t, ti) =>
              t.rows.forEach((row, g) => {
                const f = t.frames[g]
                if (hit[ti][g]) {
                  f.r = P.volt[0]
                  f.g = P.volt[1]
                  f.b = P.volt[2]
                  jobs.push(tw.to(f, { o: 0.9 }, { duration: 400, delay: g * 40 }))
                  jobs.push(tw.to(row.filter((c) => c.data.v !== TARGET), { a: 0.55 }, { duration: 400, delay: g * 40 }))
                } else {
                  jobs.push(tw.to(f, { o: 0.08 }, { duration: 400, delay: g * 40 }))
                  jobs.push(tw.to(row, { a: 0.07 }, { duration: 400, delay: g * 40 }))
                }
              }),
            )
            await all(...jobs)
            ctx.stats([
              { label: 'Sorted by ts', value: hitCount[0], of: GRANULES, unit: '', tone: 'coral', meter: hitCount[0] / GRANULES },
              { label: 'Sorted by user_id', value: hitCount[1], of: GRANULES, tone: 'volt', meter: hitCount[1] / GRANULES },
            ])
          },
        },
        {
          title: 'Sorted data also compresses better',
          body: 'Equal values next to each other form long runs that compress to almost nothing. Put low-cardinality columns you filter on <b>first</b> in the sort key.',
          hold: 3600,
          async run() {
            // restore everything, then collapse runs of equal values inside each granule
            const all0 = tables.flatMap((t) => t.rows.flat())
            await all(
              tint(ctx, all0, (c) => keyColor(c.data.v / (USERS - 1)), { a: 1, glow: 0, duration: 600 }),
              tw.to(all0, { y: 0 }, { duration: 400 }),
              ...tables.flatMap((t) => t.frames.map((f) => tw.to(f, { o: 0.18 }, { duration: 400 }))),
              tw.to(granuleNote, { o: 0 }, { duration: 300 }),
            )
            const runs = [0, 0]
            const jobs: Promise<void>[] = []
            tables.forEach((t, ti) =>
              t.rows.forEach((row) => {
                let slot = 0
                let i = 0
                while (i < row.length) {
                  let j = i
                  while (j + 1 < row.length && row[j + 1].data.v === row[i].data.v) j++
                  const x = t.x - ((PER - 1) / 2) * XP + slot * XP
                  const run = row.slice(i, j + 1)
                  jobs.push(tw.to(run, { x, w: 0.21 }, { duration: 900, ease: 'inOutCubic', delay: slot * 25 }))
                  if (run.length > 1) jobs.push(tw.to(run.slice(1), { a: 0 }, { duration: 500, delay: 600 }))
                  slot++
                  runs[ti]++
                  i = j + 1
                }
              }),
            )
            await all(...jobs)
            ctx.stats([
              { label: 'Runs to store · ts', value: runs[0], of: GRANULES * PER, tone: 'coral', meter: runs[0] / (GRANULES * PER) },
              { label: 'Runs to store · user_id', value: runs[1], of: GRANULES * PER, tone: 'volt', meter: runs[1] / (GRANULES * PER) },
            ])
          },
        },
        {
          title: 'How to choose the key',
          body: 'Pick columns you <b>filter on</b>, put <b>lower-cardinality</b> columns first, and prefer columns that correlate with the rest of the row. The key is fixed at <code>CREATE TABLE</code>; a projection is the only way to add another order later.',
          code: 'ORDER BY tuple()                          -- 59.82M rows, 361 MB read\nORDER BY (PostTypeId, toDate(CreationDate)) -- 196.5K rows, 1.77 MB',
          hold: 5200,
          async run() {
            labels[0].set('<span class="k">ORDER BY</span>tuple()')
            labels[1].set('<span class="k">ORDER BY</span>(PostTypeId, toDate(CreationDate))')
            const right = tables[1].rows.flat().filter((c) => c.a > 0.5)
            await tw.to(right, { glow: 0.3 }, { duration: 400, delay: tw.stagger(4) }).then(() => tw.to(right, { glow: 0 }, { duration: 600 }))
            ctx.stats([
              { label: 'Granules read · tuple()', value: 7578, of: 7578, tone: 'coral', meter: 1 },
              { label: 'Granules read · good key', value: 39, of: 7578, tone: 'volt', meter: 39 / 7578 },
              { label: 'Query time', value: '55 → 13', unit: ' ms', tone: 'cyan' },
            ])
          },
        },
      ],
    }
  },
}
