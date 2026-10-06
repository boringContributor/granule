// Seeds a local ClickHouse with a demo table and, with --live, keeps inserting small batches
// so you can watch parts appear and merge in granule's Live mode.
//
//   npm run demo-db              # start a container + seed
//   node scripts/seed-demo-db.mjs --live
//
// Env: CH_URL (default http://localhost:8123), CH_USER, CH_PASSWORD

const URL_ = process.env.CH_URL || 'http://localhost:8123'
const live = process.argv.includes('--live')

async function q(sql) {
  const u = new URL(URL_)
  if (process.env.CH_USER) u.searchParams.set('user', process.env.CH_USER)
  if (process.env.CH_PASSWORD) u.searchParams.set('password', process.env.CH_PASSWORD)
  const res = await fetch(u, { method: 'POST', body: sql })
  const text = await res.text()
  if (!res.ok) throw new Error(text)
  return text
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      await q('SELECT 1')
      return
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error(`ClickHouse at ${URL_} did not come up`)
}

const ROW = (dateExpr) => `
  SELECT
    ${dateExpr} AS event_date,
    toDateTime(event_date) + rand() % 86400 AS event_time,
    ['pageview','pageview','pageview','click','click','signup','purchase'][rand() % 7 + 1] AS event_type,
    rand64() % 2000000 AS user_id,
    ['US','DE','FR','GB','JP','BR','IN','NL','SE','ES','CA','AU'][rand() % 12 + 1] AS country,
    concat('/', ['home','pricing','docs','blog','signup','checkout'][rand() % 6 + 1], '/', toString(rand() % 500)) AS url,
    rand() % 60000 AS duration_ms,
    if(event_type = 'purchase', (rand() % 50000) / 100, 0) AS revenue`

await waitForServer()
await q('CREATE DATABASE IF NOT EXISTS demo')

const exists = (await q(`EXISTS TABLE demo.events`)).trim() === '1'
if (!exists) {
  await q(`
    CREATE TABLE demo.events (
      event_date  Date,
      event_time  DateTime,
      event_type  LowCardinality(String),
      user_id     UInt64,
      country     LowCardinality(String),
      url         String,
      duration_ms UInt32,
      revenue     Decimal(10, 2)
    ) ENGINE = MergeTree
    PARTITION BY toYYYYMM(event_date)
    ORDER BY (event_type, event_date, user_id)`)

  // six months of history, written in many inserts so there are parts to merge
  for (let m = 5; m >= 0; m--) {
    for (let b = 0; b < 6; b++) {
      await q(`INSERT INTO demo.events ${ROW(`toStartOfMonth(today()) - toIntervalMonth(${m}) + rand() % 28`)} FROM numbers(${150000 + b * 40000})`)
    }
    process.stdout.write(`seeded month -${m}\n`)
  }
  console.log('demo.events ready')
} else console.log('demo.events already exists')

if (live) {
  console.log('inserting a small batch every 2s (Ctrl+C to stop)…')
  for (;;) {
    const n = 20000 + Math.floor(Math.random() * 60000)
    await q(`INSERT INTO demo.events ${ROW('today() - rand() % 3')} FROM numbers(${n})`)
    process.stdout.write(`+${n} `)
    await new Promise((r) => setTimeout(r, 2000))
  }
}
