import type { Cell } from '../engine/Cells'
import { COLUMN_HUES, P, keyColor, mix, scale } from '../engine/palette'
import { all, center, drop, fade, fitRig, packet, rng, setCamera, spawn, tint, type V3 } from './kit'
import type { SceneDef } from './types'

const POSTS_X = -5.2
const VOTES_X = 5.2
const POSTS = 10
const VOTES = 12
const BUCKETS = 6
const FULL = { x0: -6.6, x1: 6.6, z0: -3, z1: 2.8 }

const rowZ = (r: number, n: number, pitch = 0.42) => (r - (n - 1) / 2) * pitch
const idColor = (id: number) => keyColor(id / (VOTES - 1))

export const dictionaries: SceneDef = {
  id: 'dictionaries',
  title: 'Dictionaries',
  kicker: 'In-memory lookups instead of JOINs',
  blurb: 'A JOIN rebuilds its hash table on every query; a dictionary keeps one in memory.',
  docs: 'https://clickhouse.com/docs/concepts/features/dictionaries/index',
  create(ctx) {
    const { world, tw, cells } = ctx
    const rand = rng(31)

    // posts: Id + two wide columns; votes: PostId + UpVotes
    const postIds = Array.from({ length: POSTS }, () => Math.floor(rand() * VOTES))
    const posts = postIds.map((id, r) =>
      [0, 1, 2].map((c) =>
        spawn(ctx, {
          x: POSTS_X + (c - 1) * 0.5 + (c === 0 ? 0 : 0.05),
          z: rowZ(r, POSTS),
          w: c === 0 ? 0.3 : 0.44,
          d: 0.3,
          h: 0.15,
          color: c === 0 ? idColor(id) : scale(COLUMN_HUES[c === 1 ? 0 : 2], 0.7),
          data: { id },
        }),
      ),
    )
    const votes = Array.from({ length: VOTES }, (_, id) =>
      [0, 1].map((c) =>
        spawn(ctx, {
          x: VOTES_X + (c - 0.5) * 0.48,
          z: rowZ(id, VOTES, 0.38),
          w: c === 0 ? 0.3 : 0.4,
          d: 0.28,
          h: 0.15,
          color: c === 0 ? idColor(id) : scale(COLUMN_HUES[4], 0.85),
          data: { id },
        }),
      ),
    )
    const postsTitle = world.label('<span class="k">left</span>posts · 60M rows', POSTS_X, 0.02, rowZ(0, POSTS) - 0.55, 'tag', 0)
    const votesTitle = world.label('<span class="k">right</span>votes', VOTES_X, 0.02, rowZ(0, VOTES, 0.38) - 0.55, 'tag', 0)

    // hash table area in the middle: buckets by id % BUCKETS
    const bucketZ = (b: number) => (b - (BUCKETS - 1) / 2) * 0.72
    const slotOf = new Map<number, { x: number; z: number }>()
    const fill = Array(BUCKETS).fill(0)
    for (let id = 0; id < VOTES; id++) {
      const b = id % BUCKETS
      slotOf.set(id, { x: -0.55 + fill[b] * 0.55, z: bucketZ(b) })
      fill[b]++
    }
    const frame = world.rect(0, 0.005, 0, 2.6, BUCKETS * 0.72 + 0.3, P.steel, 0, true)
    const frameTitle = world.label('', 0, 0.02, bucketZ(0) - 0.75, 'tag', 0)

    let table: Cell[] = []
    const build = async (violet: boolean, speed = 1) => {
      table = votes.map((row) => {
        const id = row[0].data.id
        return cells.alloc({ x: row[0].x, y: 0, z: row[0].z, w: 0.42, d: 0.3, h: 0.16, a: 1, color: violet ? mix(idColor(id), P.violet, 0.35) : idColor(id), data: { id } })
      })
      await all(
        ...table.map((c, i) => {
          const s = slotOf.get(c.data.id)!
          return tw.to(c, { y: 0.9 }, { duration: 300 * speed, delay: i * 50 * speed }).then(() => tw.to(c, { x: s.x, z: s.z, y: 0 }, { duration: 700 * speed, ease: 'inOutCubic' }))
        }),
      )
    }

    /** Each left row looks up its key and gets UpVotes back. */
    const probe = async (color = P.cyan) => {
      const jobs = posts.map((row, r) => {
        const id = row[0].data.id
        const s = slotOf.get(id)!
        const from = center(row[0])
        const to: V3 = [s.x, 0.25, s.z]
        return packet(ctx, from, to, { lift: 0.7, duration: 650, delay: r * 90, size: 0.1, color: idColor(id), glow: 0.8 }).then(() =>
          packet(ctx, to, [POSTS_X + 1.05, 0.15, row[0].z], { lift: 0.7, duration: 650, size: 0.1, color, glow: 0.8 }),
        )
      })
      await all(...jobs)
    }

    const result = posts.map((row) => cells.alloc({ x: POSTS_X + 1.05, z: row[0].z, w: 0.36, d: 0.26, h: 0.14, a: 0, color: scale(COLUMN_HUES[4], 0.85) }))
    const resultTitle = world.label('UpVotes', POSTS_X + 1.05, 0.02, rowZ(POSTS - 1, POSTS) + 0.5, 'small', 0)
    const timer = world.label('', 0, 1.5, 0, 'tag', 0)

    setCamera(ctx, fitRig(ctx, FULL, { theta: -0.05, phi: 0.84 }))

    return {
      steps: [
        {
          title: 'Enriching rows with a JOIN',
          body: 'To add vote counts to posts, a query joins two tables. By default ClickHouse builds a hash table from the <b>right-hand</b> table, so keep the smaller table on the right and filter before joining.',
          code: 'SELECT p.Title, v.UpVotes\nFROM posts AS p LEFT JOIN votes AS v ON p.Id = v.PostId',
          async run() {
            await all(drop(ctx, posts.flat(), { each: 10, duration: 600 }), drop(ctx, votes.flat(), { each: 10, duration: 600 }), tw.to([postsTitle, votesTitle], { o: 1 }, { duration: 500 }))
          },
        },
        {
          title: 'Every query builds a hash table',
          body: 'The right table is read and hashed into memory before a single left row is matched. In the docs’ Stack Overflow example this peaks at <b>3.18 GB</b> of memory.',
          async run() {
            frameTitle.set('<span class="k">per query</span>hash table')
            await all(tw.to(frame, { o: 0.5 }, { duration: 400 }), tw.to(frameTitle, { o: 1 }, { duration: 400 }))
            await build(false)
            ctx.stats([
              { label: 'Hash tables built', value: 1, tone: 'coral' },
              { label: 'Peak memory', value: '3.18 GB', tone: 'coral' },
            ])
          },
        },
        {
          title: '…probes it, then throws it away',
          body: 'Each left row looks up its key. When the query ends the hash table is discarded, and the next query builds it all over again.',
          async run() {
            await all(probe(), tw.to(resultTitle, { o: 1 }, { duration: 400 }))
            await tw.to(result, { a: 1 }, { duration: 300, delay: tw.stagger(40) })
            await all(fade(ctx, table, 0, { duration: 600 }), tw.to(frame, { o: 0.15 }, { duration: 500 }), tw.to(frameTitle, { o: 0 }, { duration: 400 }))
            cells.release(table)
            table = []
            await fade(ctx, result, 0, { duration: 400 })
            ctx.stats([
              { label: 'Query time', value: '1.283 s', tone: 'coral' },
              { label: 'Hash tables kept', value: 0 },
            ])
          },
        },
        {
          title: 'A dictionary stays in memory',
          body: 'A dictionary loads a key-value source once (a ClickHouse table, a file, HTTP, Postgres…) into a layout like <code>HASHED</code>, <code>FLAT</code>, <code>RANGE_HASHED</code>, <code>IP_TRIE</code> or <code>CACHE</code>, and keeps it resident.',
          code: "CREATE DICTIONARY votes_dict (PostId UInt64, UpVotes UInt32)\nPRIMARY KEY PostId SOURCE(CLICKHOUSE(TABLE 'votes'))\nLAYOUT(HASHED()) LIFETIME(MIN 600 MAX 900)",
          async run() {
            frameTitle.set('<span class="k">resident</span>votes_dict · HASHED')
            frameTitle.el.className = 'lbl tag violet'
            frame.r = P.violet[0]
            frame.g = P.violet[1]
            frame.b = P.violet[2]
            await all(tw.to(frame, { o: 0.8 }, { duration: 400 }), tw.to(frameTitle, { o: 1 }, { duration: 400 }))
            await build(true)
            ctx.stats([{ label: 'Loaded', value: 'once', tone: 'violet' }])
          },
        },
        {
          title: 'dictGet is a direct lookup',
          body: 'Rows just look up their key in the resident structure: nothing is built per query. In the docs’ example the query drops from <b>1.283 s to 0.551 s</b> and peak memory from 3.18 GB to <b>552 MB</b>.',
          code: "SELECT Title, dictGet('votes_dict', 'UpVotes', Id) FROM posts",
          async run() {
            await probe(P.violet)
            await tw.to(result, { a: 1 }, { duration: 300, delay: tw.stagger(40) })
            ctx.stats([
              { label: 'Query time', value: '0.551 s', of: '1.283 s', tone: 'volt' },
              { label: 'Peak memory', value: '552 MB', of: '3.18 GB', tone: 'cyan' },
              { label: 'Hash tables built', value: 0, tone: 'cyan' },
            ])
          },
        },
        {
          title: 'Refreshed on its LIFETIME',
          body: 'The dictionary reloads from its source at a random point between <code>MIN</code> and <code>MAX</code> seconds, spreading load; <code>SYSTEM RELOAD DICTIONARY</code> forces it. Use it in a <code>MATERIALIZED</code> column to enrich rows at insert time.',
          code: 'SYSTEM RELOAD DICTIONARY votes_dict',
          hold: 3600,
          async run() {
            const t = { s: 0 }
            const show = () => timer.set(`<span class="k">next reload</span>${Math.round(t.s)} s · random in 600–900`)
            show()
            await tw.to(timer, { o: 1 }, { duration: 300 })
            await tw.to(t, { s: 742 }, { duration: 1600, ease: 'inOutSine', onUpdate: show })
            // the source is read again and the structure swapped in
            await tint(ctx, votes.flat(), (c) => mix([c.r, c.g, c.b], P.white, 0.2), { duration: 300, glow: 0.3 })
            const old = table
            await all(fade(ctx, old, 0.2, { duration: 300 }), tint(ctx, votes.flat(), (c) => (c.x < VOTES_X ? idColor(c.data.id) : scale(COLUMN_HUES[4], 0.85)), { duration: 500, glow: 0 }))
            await build(true, 0.5)
            cells.release(old)
            await tw.to(timer, { o: 0 }, { duration: 300 })
          },
        },
      ],
    }
  },
}
