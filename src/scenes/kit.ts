import type { Cell, CellInit } from '../engine/Cells'
import { arcPath, type Rig } from '../engine/World'
import { P, type RGB } from '../engine/palette'
import type { Ctx } from './types'

export type V3 = [number, number, number]

/** Seeded PRNG so every demo plays out the same way each time. */
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export const fmt = (n: number) => {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'
  if (n >= 1e4) return (n / 1e3).toFixed(0) + 'K'
  return n.toLocaleString('en-US')
}

export const fmtBytes = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`
}

export function camera(ctx: Ctx, to: Partial<Rig>, duration = 1800) {
  return ctx.tw.to(ctx.world.rig, to as any, { duration, ease: 'inOutQuart' })
}

export interface Box {
  x0: number
  x1: number
  z0: number
  z1: number
  /** tallest thing in the box */
  y1?: number
}

/** Rig values that frame a box on the floor, leaving room for the caption and stats panels. */
export function fitRig(ctx: Ctx, b: Box, opts: { theta?: number; phi?: number; pad?: number; min?: number; usable?: number } = {}): Partial<Rig> {
  const { world } = ctx
  const theta = opts.theta ?? world.rig.theta
  const phi = opts.phi ?? world.rig.phi
  const halfW = (b.x1 - b.x0) / 2
  const halfD = (b.z1 - b.z0) / 2
  const ex = Math.abs(halfW * Math.cos(theta)) + Math.abs(halfD * Math.sin(theta))
  const ez = Math.abs(halfW * Math.sin(theta)) + Math.abs(halfD * Math.cos(theta))
  const screenH = ez * Math.cos(phi) + ((b.y1 ?? 0.4) / 2) * Math.sin(phi)
  const t = Math.tan(((world.camera.fov / 2) * Math.PI) / 180)
  const aspect = world.camera.aspect
  const radius = Math.max(opts.min ?? 6, Math.max(ex / (t * aspect * (opts.usable ?? 0.8)), screenH / (t * 0.6)) * (opts.pad ?? 1.08))
  return { tx: (b.x0 + b.x1) / 2, ty: 0, tz: (b.z0 + b.z1) / 2, theta, phi, radius }
}

export function fit(ctx: Ctx, b: Box, opts: { theta?: number; phi?: number; pad?: number; min?: number; usable?: number; duration?: number } = {}) {
  return camera(ctx, fitRig(ctx, b, opts), opts.duration ?? 1600)
}

export function setCamera(ctx: Ctx, to: Partial<Rig>) {
  Object.assign(ctx.world.rig, to)
}

/** Allocate a cell that starts invisible and lifted, ready for `drop`. */
export function spawn(ctx: Ctx, init: CellInit & { x: number; y?: number; z: number }) {
  const c = ctx.cells.alloc({ a: 0, ...init })
  c.data = { ...(c.data || {}), home: { x: init.x, y: init.y ?? 0, z: init.z } }
  return c
}

/** Bring cells in: fall from above while fading in. */
export function drop(ctx: Ctx, cells: Cell[], opts: { from?: number; each?: number; duration?: number; a?: number } = {}) {
  const from = opts.from ?? 3
  for (const c of cells) {
    const home = c.data?.home
    if (home) c.y = home.y + from
  }
  return ctx.tw.to(
    cells,
    { y: (c: Cell) => c.data?.home?.y ?? 0, a: opts.a ?? 1 },
    { duration: opts.duration ?? 900, delay: ctx.tw.stagger(opts.each ?? 6), ease: 'outExpo' },
  )
}

export function fade(ctx: Ctx, cells: Cell[], a: number, opts: { duration?: number; each?: number; glow?: number } = {}) {
  const props: any = { a }
  if (opts.glow !== undefined) props.glow = opts.glow
  return ctx.tw.to(cells, props, { duration: opts.duration ?? 700, delay: ctx.tw.stagger(opts.each ?? 0), ease: 'inOutSine' })
}

/** Recolor cells, with an optional per-cell color function. */
export function tint(ctx: Ctx, cells: Cell[], color: RGB | ((c: Cell, i: number) => RGB), opts: { duration?: number; each?: number; a?: number; glow?: number } = {}) {
  const f = typeof color === 'function' ? color : () => color
  const props: any = {
    r: (c: Cell, i: number) => f(c, i)[0],
    g: (c: Cell, i: number) => f(c, i)[1],
    b: (c: Cell, i: number) => f(c, i)[2],
  }
  if (opts.a !== undefined) props.a = opts.a
  if (opts.glow !== undefined) props.glow = opts.glow
  return ctx.tw.to(cells, props, { duration: opts.duration ?? 700, delay: ctx.tw.stagger(opts.each ?? 0), ease: 'inOutSine' })
}

/** A quick flash of glow that settles back. */
export async function pulse(ctx: Ctx, cells: Cell[], peak = 1.2, settle = 0, opts: { each?: number; duration?: number } = {}) {
  await ctx.tw.to(cells, { glow: peak }, { duration: (opts.duration ?? 500) * 0.4, delay: ctx.tw.stagger(opts.each ?? 0), ease: 'outQuad' })
  await ctx.tw.to(cells, { glow: settle }, { duration: (opts.duration ?? 500) * 0.6, ease: 'inOutSine' })
}

/** Send a glowing packet along an arc. Resolves when it arrives (and is removed). */
export async function packet(
  ctx: Ctx,
  from: V3,
  to: V3,
  opts: { color?: RGB; lift?: number; duration?: number; delay?: number; size?: number; keep?: boolean; glow?: number } = {},
): Promise<Cell> {
  const s = opts.size ?? 0.14
  const c = ctx.cells.alloc({ w: s, h: s, d: s, a: 0, glow: opts.glow ?? 1.4, color: opts.color ?? P.volt })
  c.path = arcPath(from, to, opts.lift ?? 2)
  c.p = 0
  if (opts.delay) await ctx.tw.wait(opts.delay)
  c.a = 1
  await ctx.tw.to(c, { p: 1 }, { duration: opts.duration ?? 900, ease: 'inOutSine' })
  if (!opts.keep) ctx.cells.release(c)
  else {
    const q = c.path(1)
    c.path = undefined
    c.x = q[0]
    c.y = q[1]
    c.z = q[2]
  }
  return c
}

/** Many packets at once, each with a small stagger. */
export function stream(
  ctx: Ctx,
  froms: V3[],
  to: V3 | ((i: number) => V3),
  opts: { color?: RGB | ((i: number) => RGB); lift?: number; duration?: number; each?: number; size?: number; jitter?: number } = {},
) {
  const each = opts.each ?? 20
  return Promise.all(
    froms.map((f, i) =>
      packet(ctx, f, typeof to === 'function' ? to(i) : to, {
        color: typeof opts.color === 'function' ? opts.color(i) : opts.color,
        lift: opts.lift,
        duration: (opts.duration ?? 900) * (1 + ((i * 37) % 11) / 40),
        delay: i * each,
        size: opts.size,
      }),
    ),
  )
}

export const center = (c: Cell): V3 => [c.x, c.y + c.h / 2, c.z]

/** Run promises concurrently while letting each one be written inline. */
export const all = (...ps: Promise<unknown>[]) => Promise.all(ps).then(() => undefined)
