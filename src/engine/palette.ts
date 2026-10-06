import * as THREE from 'three'

/** RGB triples in linear-ish 0..1 space, ready to be written into cell colors. */
export type RGB = [number, number, number]

const hex = (h: string): RGB => {
  const c = new THREE.Color(h)
  return [c.r, c.g, c.b]
}

export const P = {
  bg: '#07080b',
  ink: hex('#1b1f29'),
  slate: hex('#2b3240'),
  steel: hex('#4a5468'),
  mist: hex('#8a96ad'),
  white: hex('#e9eef7'),
  volt: hex('#f5ff6b'), // signature accent
  cyan: hex('#4fe3d1'),
  sky: hex('#5aa9ff'),
  violet: hex('#a68bff'),
  coral: hex('#ff6f7d'),
  amber: hex('#ffb547'),
  lime: hex('#8cf27a'),
}

/** Distinct, slightly muted hues for table columns. */
export const COLUMN_HUES: RGB[] = [
  hex('#5aa9ff'),
  hex('#4fe3d1'),
  hex('#a68bff'),
  hex('#ff8fb1'),
  hex('#ffb547'),
  hex('#8cf27a'),
  hex('#7fd4ff'),
  hex('#d59bff'),
]

/** A smooth gradient used to color sort-key values: sorted data reads as a calm ramp, unsorted as noise. */
const KEY_STOPS = ['#2a6cff', '#33c8e8', '#4fe3a0', '#e7f56b', '#ffb547', '#ff6f7d'].map(hex)

export function keyColor(t: number): RGB {
  const x = Math.min(0.9999, Math.max(0, t)) * (KEY_STOPS.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = KEY_STOPS[i]
  const b = KEY_STOPS[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export function scale(a: RGB, k: number): RGB {
  return [a[0] * k, a[1] * k, a[2] * k]
}
