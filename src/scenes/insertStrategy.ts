import type { Cell } from '../engine/Cells'
import { COLUMN_HUES, P, keyColor, mix, scale } from '../engine/palette'
import { all, center, fade, fit, fitRig, packet, rng, setCamera, tint, type V3 } from './kit'
import type { SceneDef } from './types'

const CLIENTS = 6
const CLIENT_X = -7
const BUF_X = -3
const SLOT_COLS = 6
const TX = 3.4
const FULL = { x0: -7.8, x1: 7, z0: -3.4, z1: 3.2 }

const clientZ = (i: number) => (i - (CLIENTS - 1) / 2) * 1.15
const slotPos = (k: number) => ({ x: TX - 2.5 + (k % SLOT_COLS) * 1.0, z: -2.35 + Math.floor(k / SLOT_COLS) * 0.95 })

export const insertStrategy: SceneDef = {
  id: 'insert-strategy',
  title: 'Selecting an insert strategy',
  kicker: 'Batches and async inserts',
  blurb: 'Every synchronous insert becomes a part, so batch them on the client or let the server buffer them.',
  docs: 'https://clickhouse.com/docs/concepts/best-practices/selecting-an-insert-strategy',
  create(ctx) {
    const { world, tw, cells } = ctx
    const rand = rng(17)

    const clients = Array.from({ length: CLIENTS }, (_, i) =>
      cells.alloc({ x: CLIENT_X, y: 0, z: clientZ(i), w: 0.75, h: 0.32, d: 0.7, a: 0, color: P.steel }),
    )
    const clientTitle = world.label('clients', CLIENT_X, 0.02, clientZ(0) - 0.75, 'small', 0)
    const tableOutline = world.rect(TX, 0.005, 0, 6.5, 6, P.steel, 0, true)
    const tableTitle = world.label('<span class="k">MergeTree</span>events', TX, 0.02, -3.3, 'tag', 0)
    const bufBox = world.box(BUF_X, 0, 0, 1.8, 0.9, 3, P.violet, 0)
    const bufTitle = world.label('<span class="k">server</span>async insert buffer', BUF_X, 0.02, -1.9, 'tag violet', 0)
    const bufTimer = world.label('', BUF_X, 1.35, 0, 'tag', 0)
    const warn = world.label('TOO_MANY_PARTS', TX, 1.4, 3.2, 'tag coral', 0)
    const note = world.label('', TX, 1.2, -2.2, 'tag', 0)

    let parts: Cell[][] = []
    const partRows = new Map<Cell[], number>()

    /** A part with `rows` rows of 3 columns at slot k, initially invisible. */
    const makePart = (k: number, rows: number, tone = 0) => {
      const { x, z } = slotPos(k)
      const part: Cell[] = []
      const span = rows > 1 ? 0.62 / (rows - 1) : 0
      for (let r = 0; r < rows; r++) {
        const key = rows > 1 ? r / (rows - 1) : rand()
        for (let c = 0; c < 3; c++)
          part.push(
            cells.alloc({
              x: x + (c - 1) * 0.29,
              z: z - 0.31 + r * span,
              w: 0.25,
              d: rows > 1 ? Math.min(0.2, span * 0.8) : 0.2,
              h: 0.13,
              a: 0,
              color: tone ? mix(scale(keyColor(key), 0.9 - c * 0.12), COLUMN_HUES[1], 0.15) : scale(keyColor(key), 0.92 - c * 0.12),
            }),
          )
      }
      parts.push(part)
      partRows.set(part, rows)
      return part
    }

    const stats = (q: number, extra: { label: string; value: number | string; tone?: 'volt' | 'cyan' | 'coral' | 'violet' | 'mist' }[] = []) =>
      ctx.stats([{ label: 'Active parts', value: parts.length, tone: parts.length > 20 ? 'coral' : 'volt' }, { label: 'Insert queries', value: q }, ...extra])

    const clearSmall = async () => {
      const tiny = parts.filter((p) => partRows.get(p)! <= 1)
      await fade(ctx, tiny.flat(), 0, { duration: 500 })
      cells.release(tiny.flat())
      parts = parts.filter((p) => !tiny.includes(p))
    }

    let queries = 0
    setCamera(ctx, fitRig(ctx, FULL, { theta: -0.08, phi: 0.86 }))

    return {
      steps: [
        {
          title: 'Every INSERT becomes a part',
          body: 'A synchronous insert is parsed, sorted, compressed and written to disk as a new <b>part</b> before ClickHouse acknowledges it. One query, one part.',
          code: 'INSERT INTO events FORMAT Native   -- 50,000 rows',
          async run() {
            await all(
              tw.to(clients, { a: 1 }, { duration: 500, delay: tw.stagger(60) }),
              tw.to([clientTitle, tableTitle], { o: 1 }, { duration: 500 }),
              tw.to(tableOutline, { o: 0.45 }, { duration: 600 }),
            )
            const part = makePart(0, 6)
            const from = center(clients[2])
            await all(...Array.from({ length: 6 }, (_, i) => packet(ctx, from, [slotPos(0).x, 0.2, slotPos(0).z], { lift: 1.6, duration: 900, delay: i * 70, size: 0.12, color: P.cyan })))
            queries = 1
            await tw.to(part, { a: 1 }, { duration: 500, delay: tw.stagger(15) })
            stats(queries, [{ label: 'Rows per insert', value: '50,000', tone: 'cyan' }])
          },
        },
        {
          title: 'Row-by-row inserts flood the table',
          body: 'Thirty tiny inserts make thirty tiny parts. Merges can’t keep up, and past a limit ClickHouse rejects writes with <b>TOO_MANY_PARTS</b>.',
          code: "INSERT INTO events VALUES ('2024-10-01', 'click', 42)   -- × 30",
          async run() {
            const jobs: Promise<unknown>[] = []
            for (let i = 0; i < 30; i++) {
              const part = makePart(i + 1, 1)
              const c = i % CLIENTS
              const s = slotPos(i + 1)
              jobs.push(
                packet(ctx, center(clients[c]), [s.x, 0.15, s.z], { lift: 1.3, duration: 800, delay: i * 85, size: 0.1, color: P.coral, glow: 0.8 }).then(() => {
                  queries++
                  stats(queries, [{ label: 'Rows per insert', value: 1, tone: 'coral' }])
                  return tw.to(part, { a: 1 }, { duration: 250 })
                }),
              )
            }
            await all(...jobs)
            await tw.to(warn, { o: 1 }, { duration: 400 })
          },
        },
        {
          title: 'Batch on the client',
          body: 'Collect rows first and send them together: at least <b>1,000</b> rows per insert, ideally <b>10,000–100,000</b>, at roughly one insert per second. Fewer, bigger parts mean less merge work.',
          async run() {
            await all(tw.to(warn, { o: 0 }, { duration: 300 }), clearSmall())
            queries = 1
            stats(queries)
            const batch = Array.from({ length: 30 }, (_, i) =>
              cells.alloc({ x: CLIENT_X + 1.6 + (i % 5) * 0.16, y: Math.floor(i / 5) * 0.12, z: 0, w: 0.13, h: 0.1, d: 0.3, a: 0, color: keyColor(rand()) }),
            )
            note.x = CLIENT_X + 1.95
            note.z = -0.8
            note.y = 1.3
            note.set('<span class="k">client-side</span>batch')
            await all(
              tw.to(note, { o: 1 }, { duration: 400 }),
              ...batch.map((b, i) => {
                const from = clients[i % CLIENTS]
                b.x = from.x
                b.z = from.z
                b.y = 0.3
                return tw.to(b, { a: 1 }, { duration: 150, delay: i * 50 }).then(() =>
                  tw.to(b, { x: CLIENT_X + 1.6 + (i % 5) * 0.16, y: Math.floor(i / 5) * 0.12, z: 0 }, { duration: 500, ease: 'outCubic' }),
                )
              }),
            )
            const part = makePart(1, 6)
            const s = slotPos(1)
            await all(
              tw.to(note, { o: 0 }, { duration: 300 }),
              ...batch.map((b, i) => tw.to(b, { x: s.x, z: s.z, y: 0.6, a: 0 }, { duration: 900, delay: i * 12, ease: 'inOutCubic' })),
            )
            cells.release(batch)
            queries++
            await tw.to(part, { a: 1 }, { duration: 500 })
            stats(queries, [{ label: 'Rows per insert', value: '10,000+', tone: 'cyan' }])
          },
        },
        {
          title: 'Or let the server batch: async inserts',
          body: 'With <code>async_insert = 1</code>, small inserts land in a server buffer. It flushes as one part when the first limit hits: <b>200 ms</b>, <b>100 MiB</b> or <b>450 queries</b>.',
          code: 'INSERT INTO events SETTINGS async_insert = 1 VALUES (…)',
          async run() {
            await all(
              tw.to(bufBox, { o: 0.75 }, { duration: 500 }),
              tw.to(bufTitle, { o: 1 }, { duration: 500 }),
              fit(ctx, FULL, { theta: -0.06, phi: 0.84, duration: 1000 }),
            )
            await asyncRound(2, false)
          },
        },
        {
          title: 'wait_for_async_insert decides the ack',
          body: 'By default (<code>wait_for_async_insert = 1</code>) clients are acknowledged only after the buffer is flushed to disk. Setting it to 0 acks immediately: faster, but data still in the buffer can be lost.',
          async run() {
            await asyncRound(3, true)
          },
        },
        {
          title: 'Retries are safe, formats matter',
          body: 'Inserts are deduplicated by default, so resending a block after a timeout won’t duplicate it. Send <b>Native</b> format with LZ4 or ZSTD compression to save parsing and bandwidth.',
          code: 'INSERT INTO events FORMAT Native   -- same block, retried',
          hold: 3600,
          async run() {
            const s = slotPos(2)
            const p = await packet(ctx, center(clients[4]), [s.x, 0.4, s.z], { lift: 1.6, duration: 1000, size: 0.2, color: P.cyan, keep: true })
            note.x = s.x
            note.z = s.z - 0.75
            note.y = 1
            note.set('<span class="k">block hash seen</span>deduplicated')
            await all(tw.to(note, { o: 1 }, { duration: 300 }), tint(ctx, [p], P.mist, { duration: 300 }))
            await tw.to(p, { y: 1.6, a: 0 }, { duration: 700, ease: 'inQuad' })
            cells.release(p)
            queries++
            stats(queries, [{ label: 'Duplicates written', value: 0, tone: 'cyan' }])
          },
        },
      ],
    }

    /** Tiny inserts fill the server buffer, a timer runs, the buffer flushes into one part. */
    async function asyncRound(slot: number, acks: boolean) {
      const n = 30
      const buffered = Array.from({ length: n }, (_, i) =>
        cells.alloc({ x: BUF_X - 0.5 + (i % 5) * 0.25, y: Math.floor(i / 10) * 0.14, z: -0.95 + (Math.floor(i / 5) % 2) * 0.32 + (Math.floor(i / 10) % 3) * 0.66, w: 0.18, h: 0.1, d: 0.22, a: 0, color: keyColor(rand()) }),
      )
      const timer = { ms: 0 }
      bufTimer.set('0 ms / 200 ms')
      const showTimer = () => bufTimer.set(`${Math.round(timer.ms)} ms / 200 ms`)
      await all(
        tw.to(bufTimer, { o: 1 }, { duration: 300 }),
        tw.to(timer, { ms: 200 }, { duration: n * 70 + 700, ease: 'linear', onUpdate: showTimer }),
        acks ? tint(ctx, clients, P.amber, { duration: 400, glow: 0.25 }) : Promise.resolve(),
        ...buffered.map((b, i) =>
          packet(ctx, center(clients[i % CLIENTS]), [b.x, b.y + 0.1, b.z], { lift: 0.9, duration: 650, delay: i * 70, size: 0.09, color: P.violet, glow: 0.8 }).then(() => {
            queries++
            stats(queries)
            return tw.to(b, { a: 1 }, { duration: 150 })
          }),
        ),
      )
      showTimer()
      const part = makePart(slot, 6, 1)
      const s = slotPos(slot)
      await all(
        tw.to(bufBox, { o: 1 }, { duration: 150 }).then(() => tw.to(bufBox, { o: 0.75 }, { duration: 400 })),
        ...buffered.map((b, i) => tw.to(b, { x: s.x, z: s.z, y: 0.5, a: 0 }, { duration: 900, delay: i * 10, ease: 'inOutCubic' })),
      )
      cells.release(buffered)
      await all(tw.to(part, { a: 1 }, { duration: 500 }), tw.to(bufTimer, { o: 0 }, { duration: 300 }))
      stats(queries, [{ label: 'Parts from 30 queries', value: 1, tone: 'cyan' }])
      if (acks) {
        await all(...clients.map((c, i) => packet(ctx, [BUF_X, 0.5, 0] as V3, center(c), { lift: 0.8, duration: 700, delay: i * 50, size: 0.1, color: P.cyan })))
        await tint(ctx, clients, P.steel, { duration: 400, glow: 0 })
      }
    }
  },
}
