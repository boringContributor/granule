// Records the 15-second overview loop into docs/hero.webp (for the README) and docs/hero.mp4.
//
//   npm run dev            # in another terminal
//   npm run record -- http://localhost:5173
//
// Uses the Chrome DevTools screencast for smooth frames, then ffmpeg for encoding.
import { chromium } from 'playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const base = process.argv[2] || 'http://localhost:5173'
const seconds = Number(process.argv[3] || 14.2)
const W = 1280
const H = 720
const frames = join(import.meta.dirname, '.frames')
const out = join(import.meta.dirname, '..', 'docs')
rmSync(frames, { recursive: true, force: true })
mkdirSync(frames, { recursive: true })
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', args: ['--use-angle=metal', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
await page.goto(`${base}/?record#/overview`)
await page.waitForFunction(() => window.__granule?.player.state.count > 0)
// start from a clean first frame
await page.evaluate(() => window.__granule.player.restart())

const cdp = await page.context().newCDPSession(page)
const list = []
let t0 = null
cdp.on('Page.screencastFrame', async (f) => {
  const ts = f.metadata.timestamp
  if (t0 === null) t0 = ts
  const file = join(frames, `f${String(list.length).padStart(5, '0')}.jpg`)
  writeFileSync(file, Buffer.from(f.data, 'base64'))
  list.push({ file, t: ts - t0 })
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
})
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
await page.waitForTimeout(seconds * 1000)
await cdp.send('Page.stopScreencast')
await browser.close()

// ffmpeg concat demuxer with real frame durations
const lines = []
list.forEach((f, i) => {
  const next = list[i + 1]?.t ?? f.t + 1 / 30
  lines.push(`file '${f.file}'`, `duration ${(next - f.t).toFixed(4)}`)
})
lines.push(`file '${list[list.length - 1].file}'`)
const concat = join(frames, 'list.txt')
writeFileSync(concat, lines.join('\n'))
console.log(`captured ${list.length} frames over ${list[list.length - 1].t.toFixed(1)}s`)

const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' })
ff(['-f', 'concat', '-safe', '0', '-i', concat, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', join(out, 'hero.mp4')])
ff(['-i', join(out, 'hero.mp4'), '-vf', 'fps=20,scale=960:-1:flags=lanczos', '-c:v', 'libwebp_anim', '-quality', '72', '-compression_level', '6', '-loop', '0', join(out, 'hero.webp')])
rmSync(frames, { recursive: true, force: true })
console.log('wrote docs/hero.mp4 and docs/hero.webp')
