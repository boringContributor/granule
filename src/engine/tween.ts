import { animate, engine } from 'animejs'

export const CANCELLED = Symbol('cancelled')

type Val = number | ((target: any, index: number, total: number) => number)
export type Props = Record<string, Val>

export interface TweenOpts {
  duration?: number
  delay?: number | ((target: any, index: number, total: number) => number)
  ease?: string
  onUpdate?: () => void
}

/**
 * Thin, cancellable layer over anime.js.
 *
 * - every call returns a promise, so scene steps read like a screenplay (`await tw.to(...)`)
 * - `instant` mode applies end states synchronously, used to fast-forward when jumping between steps
 * - `cancelAll()` aborts every running tween and rejects pending promises with CANCELLED
 */
export class Tweener {
  instant = false
  private gen = 0
  private live = new Set<{ anim: ReturnType<typeof animate>; reject: (e: unknown) => void }>()

  /** `1×` in the UI plays at this fraction of the authored durations. */
  static readonly BASE_SPEED = 0.72
  private paused = false

  constructor() {
    engine.speed = Tweener.BASE_SPEED
  }

  get speed() {
    return engine.speed / Tweener.BASE_SPEED
  }
  set speed(v: number) {
    engine.speed = v * Tweener.BASE_SPEED
  }

  /**
   * Freeze every running tween. (anime's engine.pause() is undone as soon as any new
   * animation is created, so tweens are paused individually instead.)
   */
  pause() {
    this.paused = true
    for (const e of this.live) e.anim.pause()
  }
  resume() {
    if (!this.paused) return
    this.paused = false
    for (const e of this.live) e.anim.resume()
  }

  to(targets: any | any[], props: Props, opts: TweenOpts = {}): Promise<void> {
    const list = Array.isArray(targets) ? targets : [targets]
    if (list.length === 0) return Promise.resolve()
    if (this.instant) {
      list.forEach((t, i) => {
        for (const k in props) {
          const v = props[k]
          t[k] = typeof v === 'function' ? v(t, i, list.length) : v
        }
      })
      opts.onUpdate?.()
      return Promise.resolve()
    }
    const gen = this.gen
    return new Promise((resolve, reject) => {
      const entry = { anim: null as any, reject }
      entry.anim = animate(list, {
        ...props,
        duration: opts.duration ?? 800,
        delay: (opts.delay as any) ?? 0,
        ease: opts.ease ?? 'inOutCubic',
        composition: 'none',
        onUpdate: opts.onUpdate,
        onComplete: () => {
          this.live.delete(entry)
          if (gen === this.gen) resolve()
          else reject(CANCELLED)
        },
      } as any)
      this.live.add(entry)
      // tweens chained after a pause start frozen too
      if (this.paused) entry.anim.pause()
    })
  }

  /** Set values immediately (no animation). */
  set(targets: any | any[], props: Record<string, number | ((t: any, i: number, n: number) => number)>) {
    const list = Array.isArray(targets) ? targets : [targets]
    list.forEach((t, i) => {
      for (const k in props) {
        const v = props[k]
        t[k] = typeof v === 'function' ? v(t, i, list.length) : v
      }
    })
  }

  /** Wait `ms` of animation time (scaled by speed, frozen while paused). */
  wait(ms: number, onProgress?: (p: number) => void): Promise<void> {
    if (this.instant) return Promise.resolve()
    const t = { v: 0 }
    return this.to(t, { v: 1 }, { duration: ms, ease: 'linear', onUpdate: onProgress && (() => onProgress(t.v)) })
  }

  /** Stagger helper: delay grows with index, optionally from a center. */
  stagger(each: number, from: 'first' | 'center' | 'last' | 'random' = 'first') {
    return (_t: any, i: number, n: number) => {
      if (from === 'center') return Math.abs(i - (n - 1) / 2) * each
      if (from === 'last') return (n - 1 - i) * each
      if (from === 'random') return Math.random() * each * n * 0.5
      return i * each
    }
  }

  cancelAll() {
    this.gen++
    for (const e of this.live) {
      e.anim.pause()
      e.reject(CANCELLED)
    }
    this.live.clear()
  }
}

export const isCancel = (e: unknown) => e === CANCELLED
