import type { World } from '../engine/World'
import type { CellField } from '../engine/Cells'
import type { Tweener } from '../engine/tween'

export type Tone = 'volt' | 'cyan' | 'coral' | 'violet' | 'mist'

export interface Stat {
  label: string
  value: number | string
  /** rendered after the value, e.g. "/ 128" */
  of?: number | string
  unit?: string
  tone?: Tone
  /** 0..1, renders a thin meter under the value */
  meter?: number
}

export interface Ctx {
  world: World
  cells: CellField
  tw: Tweener
  stats(s: Stat[] | null): void
}

export interface Step {
  title: string
  /** short HTML; <b>, <code> and <em> are styled */
  body: string
  /** optional SQL / DDL shown under the caption */
  code?: string
  /** ms to linger after the animation when autoplaying */
  hold?: number
  run(): Promise<void>
}

export interface SceneInstance {
  steps: Step[]
  /** restart automatically after the last step */
  loop?: boolean
}

export interface SceneDef {
  id: string
  title: string
  kicker: string
  blurb: string
  /** the clickhouse.com docs page this lesson visualizes */
  docs?: string
  create(ctx: Ctx): SceneInstance
}
