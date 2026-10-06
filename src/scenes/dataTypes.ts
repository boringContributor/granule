import type { Cell } from '../engine/Cells'
import type { Label } from '../engine/World'
import { COLUMN_HUES, P, mix, scale } from '../engine/palette'
import { all, drop, fade, fit, fitRig, rng, setCamera, spawn, tint } from './kit'
import type { SceneDef } from './types'

const X0 = -2.2
const BX = 0.46
const FULL = { x0: -5.4, x1: 6.2, z0: -2.6, z1: 3.1 }

interface Col {
  name: string
  type: string
  z: number
  bytes: Cell[]
  label: Label
}

const bx = (i: number) => X0 + i * BX

export const dataTypes: SceneDef = {
  id: 'data-types',
  title: 'Selecting data types',
  kicker: 'Smaller types, smaller column files',
  blurb: 'Every byte per row is paid on disk, in memory and on every scan.',
  docs: 'https://clickhouse.com/docs/concepts/best-practices/select-data-type',
  create(ctx) {
    const { world, tw, cells } = ctx
    const rand = rng(8)

    const spec = [
      { name: 'age', type: 'Int64', n: 8, hue: COLUMN_HUES[0] },
      { name: 'created', type: 'DateTime64(3)', n: 8, hue: COLUMN_HUES[2] },
      { name: 'status', type: 'String', n: 9, hue: COLUMN_HUES[4] },
      { name: 'score', type: 'Nullable(Float64)', n: 8, hue: COLUMN_HUES[1] },
    ]
    const cols: Col[] = spec.map((s, i) => {
      const z = -1.9 + i * 1.15
      const bytes = Array.from({ length: s.n }, (_, k) =>
        spawn(ctx, {
          x: bx(k),
          z,
          w: 0.4,
          d: 0.5,
          h: 0.2,
          color: s.name === 'status' ? mix(s.hue, P.white, rand() * 0.45) : scale(s.hue, 0.95 - (k % 2) * 0.08),
          data: { k },
        }),
      )
      return { name: s.name, type: s.type, z, bytes, label: world.label('', X0 - 1.75, 0.02, z, 'tag', 0) }
    })
    const setLabel = (c: Col) => c.label.set(`${c.name} <span class="k">${c.type}</span>`)
    cols.forEach(setLabel)

    // the null map: one extra byte per row, in its own file
    const score = cols[3]
    const nullZ = score.z + 0.62
    const nullMap = spawn(ctx, { x: bx(0), z: nullZ, w: 0.4, d: 0.3, h: 0.14, color: P.coral })
    const nullLabel = world.label('score.null.bin <span class="k">UInt8</span>', X0 - 1.75, 0.02, nullZ, 'tag coral', 0)
    const unit = world.label('1 box = 1 byte per row, uncompressed', bx(4), 0.02, -2.6, 'small', 0)

    const dict = ['pending', 'paid', 'shipped', 'refunded']
    const dictCells = dict.map((_, i) => cells.alloc({ x: 4.1, z: cols[2].z - 0.75 + i * 0.5, w: 0.9, d: 0.36, h: 0.14, a: 0, color: mix(COLUMN_HUES[4], P.white, i * 0.12) }))
    const dictLabels = dict.map((d, i) => world.label(`<span class="k">${i}</span>${d}`, 5.45, 0.02, cols[2].z - 0.75 + i * 0.5, 'small', 0))
    const dictTitle = world.label('dictionary · stored once', 4.6, 0.02, cols[2].z - 1.3, 'small', 0)

    const total = () => cols.reduce((s, c) => s + c.bytes.length, 0) + (nullMap.a > 0.5 ? 1 : 0)
    const stats = (tone: 'coral' | 'volt' = 'volt') => {
      const b = total()
      ctx.stats([
        { label: 'Bytes per row', value: b, tone, meter: b / 35 },
        { label: 'At 1B rows', value: `${b} GB`, tone: 'cyan' },
      ])
    }

    /** Shrink a column to n bytes: extra boxes drop away. */
    const shrink = async (c: Col, n: number, type: string) => {
      const extra = c.bytes.slice(n)
      await tint(ctx, extra, P.slate, { duration: 300 })
      await all(fade(ctx, extra, 0, { duration: 500, each: 30 }), tw.to(extra, { y: -0.2 }, { duration: 500 }))
      cells.release(extra)
      c.bytes = c.bytes.slice(0, n)
      c.type = type
      setLabel(c)
      await tw.to(c.bytes, { glow: 0.35 }, { duration: 200 }).then(() => tw.to(c.bytes, { glow: 0 }, { duration: 500 }))
    }

    setCamera(ctx, fitRig(ctx, FULL, { theta: -0.06, phi: 0.82 }))

    return {
      steps: [
        {
          title: 'Every column is a file of values',
          body: 'Each column is stored on its own, and its type decides how many bytes every row costs, on disk, in memory and on every scan.',
          code: 'CREATE TABLE users (\n  age Int64, created DateTime64(3),\n  status String, score Nullable(Float64)\n) ENGINE = MergeTree ORDER BY created',
          async run() {
            await all(
              ...cols.map((c, i) => tw.wait(i * 160).then(() => drop(ctx, c.bytes, { each: 25, duration: 600, from: 1.5 }))),
              tw.wait(700).then(() => drop(ctx, [nullMap], { duration: 600, from: 1.5 })),
              tw.to([...cols.map((c) => c.label), nullLabel, unit], { o: 1 }, { duration: 500, delay: tw.stagger(120) }),
            )
            stats('coral')
          },
        },
        {
          title: 'Use the smallest type that fits',
          body: 'Ages fit in <code>UInt8</code> (1 byte, not 8). If you only need the day, <code>Date</code> takes 2 bytes where <code>DateTime64(3)</code> takes 8. Unsigned and narrow types are free wins.',
          async run() {
            await shrink(cols[0], 1, 'UInt8')
            stats()
            await shrink(cols[1], 2, 'Date')
            stats()
          },
        },
        {
          title: 'LowCardinality for repeated strings',
          body: '<code>LowCardinality(String)</code> stores each distinct value once in a dictionary and keeps a small integer per row. Great below about 10,000 distinct values; an <code>Enum</code> works for fixed sets.',
          async run() {
            const c = cols[2]
            await all(
              tw.to(dictCells, { a: 1 }, { duration: 500, delay: tw.stagger(100) }),
              tw.to([...dictLabels, dictTitle], { o: 1 }, { duration: 500, delay: tw.stagger(100) }),
              fit(ctx, FULL, { theta: -0.1, phi: 0.82, duration: 900 }),
            )
            await shrink(c, 1, 'LowCardinality(String)')
            await tint(ctx, c.bytes, COLUMN_HUES[4], { duration: 300 })
            stats()
          },
        },
        {
          title: 'Nullable adds a second file',
          body: 'A <code>Nullable</code> column carries a separate UInt8 null map that has to be written, read and checked. Prefer a default value such as <code>DEFAULT 0</code> unless NULL really means something.',
          code: 'score Float64 DEFAULT 0',
          async run() {
            await tw.to(nullMap, { glow: 0.4 }, { duration: 300 })
            await tw.to(nullMap, { glow: 0 }, { duration: 500 })
            await all(fade(ctx, [nullMap], 0, { duration: 600 }), tw.to(nullLabel, { o: 0 }, { duration: 500 }))
            nullMap.a = 0
            score.type = 'Float64 DEFAULT 0'
            setLabel(score)
            stats()
          },
        },
        {
          title: 'From 34 to 12 bytes per row',
          body: 'Same data, a third of the bytes. Narrow types compress better and make every scan, sort and merge cheaper. Codecs like <code>Delta</code> or <code>ZSTD</code> can shrink them further.',
          hold: 3600,
          async run() {
            const all0 = cols.flatMap((c) => c.bytes)
            await tw.to(all0, { glow: 0.3 }, { duration: 300, delay: (c: Cell) => (c.x - X0) * 150 })
            await tw.to(all0, { glow: 0 }, { duration: 600 })
            ctx.stats([
              { label: 'Bytes per row', value: total(), of: 34, tone: 'volt', meter: total() / 34 },
              { label: 'At 1B rows', value: `${total()} GB`, of: '34 GB', tone: 'cyan' },
              { label: 'Saved', value: Math.round((1 - total() / 34) * 100), unit: '%', tone: 'cyan' },
            ])
          },
        },
      ],
    }
  },
}
