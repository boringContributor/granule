import type { World } from './World'
import { Tweener, isCancel } from './tween'
import type { Ctx, SceneDef, SceneInstance, Stat, Step } from '../scenes/types'

export interface PlayerState {
  scene: SceneDef | null
  index: number
  count: number
  step: Step | null
  steps: Step[]
  playing: boolean
  busy: boolean
  speed: number
  stats: Stat[] | null
  loop: boolean
}

/**
 * Drives a scene step by step. Going forward plays the next step's animation;
 * going backward (or skipping ahead) rebuilds the scene and fast-forwards in instant mode.
 */
export class Player {
  readonly tw = new Tweener()
  readonly ctx: Ctx
  private def: SceneDef | null = null
  private inst: SceneInstance | null = null
  private token = 0
  private listeners = new Set<(s: PlayerState) => void>()
  private holdListeners = new Set<(h: { p: number; left: number } | null) => void>()
  /** token of the step whose autoplay countdown is running (0 = none) */
  private holding = 0
  state: PlayerState = { scene: null, index: -1, count: 0, step: null, steps: [], playing: true, busy: false, speed: 1, stats: null, loop: false }

  constructor(readonly world: World) {
    this.ctx = {
      world,
      cells: world.cells,
      tw: this.tw,
      stats: (s) => this.patch({ stats: s }),
    }
  }

  subscribe(fn: (s: PlayerState) => void) {
    this.listeners.add(fn)
    fn(this.state)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private patch(p: Partial<PlayerState>) {
    this.state = { ...this.state, ...p }
    for (const l of this.listeners) l(this.state)
  }

  load(def: SceneDef, opts: { autoplay?: boolean } = {}) {
    this.def = def
    if (opts.autoplay !== undefined) {
      if (opts.autoplay) this.tw.resume()
      this.patch({ playing: opts.autoplay })
    }
    this.goto(0, true)
  }

  private rebuild() {
    this.tw.cancelAll()
    this.world.clear()
    this.patch({ stats: null })
    this.inst = this.def!.create(this.ctx)
    this.patch({ scene: this.def, steps: this.inst.steps, count: this.inst.steps.length, index: -1, step: null, loop: !!this.inst.loop })
  }

  async goto(n: number, forceRebuild = false) {
    if (!this.def) return
    const tok = ++this.token
    this.emitHold(null)
    const sequential = !forceRebuild && this.inst && n === this.state.index + 1 && !this.state.busy
    this.tw.cancelAll()
    this.tw.instant = false
    // manual navigation always animates, even while autoplay is paused
    this.tw.resume()
    if (!sequential) {
      this.rebuild()
      const inst = this.inst!
      this.tw.instant = true
      try {
        for (let i = 0; i < n && tok === this.token; i++) await inst.steps[i].run()
      } finally {
        if (tok === this.token) this.tw.instant = false
      }
    }
    if (tok !== this.token) return
    const step = this.inst!.steps[n]
    if (!step) return
    this.patch({ index: n, step, busy: true })
    try {
      await step.run()
    } catch (e) {
      if (isCancel(e)) return
      console.error(e)
    }
    if (tok !== this.token) return
    this.patch({ busy: false })
    if (this.state.playing) this.advanceAfterHold(tok)
  }

  /** How long to linger on a finished step before autoplay moves on (in authored ms). */
  private holdFor(step: Step) {
    const text = step.body.replace(/<[^>]+>/g, '')
    const reading = 2200 + Math.min(5600, text.length * 26)
    // looping showcases keep their authored rhythm; lessons always leave time to read
    if (this.state.loop) return step.hold ?? reading
    return Math.max(step.hold ?? 0, reading)
  }

  /** Subscribe to the autoplay countdown: progress 0..1 and seconds left, or null when not counting. */
  onHold(fn: (h: { p: number; left: number } | null) => void) {
    this.holdListeners.add(fn)
    return () => {
      this.holdListeners.delete(fn)
    }
  }

  private emitHold(h: { p: number; left: number } | null) {
    for (const l of this.holdListeners) l(h)
  }

  private async advanceAfterHold(tok: number) {
    const step = this.state.step!
    // the last step of a lesson just stays put: no countdown toward nothing
    if (this.state.index >= this.state.count - 1 && !this.state.loop) {
      this.patch({ playing: false })
      return
    }
    const hold = this.holdFor(step)
    this.holding = tok
    try {
      await this.tw.wait(hold, (p) => {
        if (tok === this.token) this.emitHold({ p, left: ((1 - p) * hold) / 1000 / (this.tw.speed * Tweener.BASE_SPEED) })
      })
    } catch {
      return
    } finally {
      if (this.holding === tok) this.holding = 0
      if (tok === this.token) this.emitHold(null)
    }
    if (tok !== this.token || !this.state.playing) return
    if (this.state.index < this.state.count - 1) this.goto(this.state.index + 1)
    else if (this.state.loop) this.goto(0, true)
    else this.patch({ playing: false })
  }

  next() {
    if (this.state.index < this.state.count - 1) this.goto(this.state.index + 1)
  }

  prev() {
    this.goto(Math.max(0, this.state.index - 1), true)
  }

  restart() {
    this.setPlaying(true)
    this.goto(0, true)
  }

  setPlaying(playing: boolean) {
    if (playing) this.tw.resume()
    else this.tw.pause()
    const wasIdle = !this.state.busy
    this.patch({ playing })
    if (playing && wasIdle && this.state.step && this.holding !== this.token) {
      // the step finished while paused: count down to the next one (or start over at the end)
      if (this.state.index < this.state.count - 1) this.advanceAfterHold(this.token)
      else this.goto(0, true)
    }
  }

  toggle() {
    this.setPlaying(!this.state.playing)
  }

  setSpeed(speed: number) {
    this.tw.speed = speed
    this.patch({ speed })
  }
}
