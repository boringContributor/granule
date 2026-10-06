import * as THREE from 'three'
import type { RGB } from './palette'

/**
 * A Cell is the single visual atom of the app: a box that can be a granule, a row, a mark,
 * a packet in flight or a piece of an aggregation state. Scenes animate plain numeric fields
 * (anime.js tweens them directly) and the field writes them into instanced GPU buffers every frame.
 */
export interface Cell {
  id: number
  x: number
  y: number
  z: number
  w: number
  h: number
  d: number
  r: number
  g: number
  b: number
  /** 1 = solid, ~0.1 = ghost outline, 0 = invisible */
  a: number
  /** extra emissive intensity, feeds the bloom pass */
  glow: number
  /** optional parametric position (0..1) — used for packets flying along curves */
  p: number
  path?: (p: number) => [number, number, number]
  /** free-form payload for scenes */
  data?: any
}

export type CellInit = Partial<Omit<Cell, 'id'>> & { color?: RGB }

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aAlpha;
attribute float aGlow;
varying vec3 vColor;
varying float vAlpha;
varying float vGlow;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vScale;
varying float vLocalY;
varying float vDepth;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vGlow = aGlow;
  vUv = uv;
  vNormal = normal;
  vLocalY = position.y;
  vScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
uniform float uPass; // 0 = opaque pass, 1 = translucent pass
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vColor;
varying float vAlpha;
varying float vGlow;
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vScale;
varying float vLocalY;
varying float vDepth;
void main() {
  vec3 n = normalize(vNormal);
  vec2 dims = abs(n.x) > 0.5 ? vScale.zy : (abs(n.y) > 0.5 ? vScale.xz : vScale.xy);
  vec2 dEdge = min(vUv, 1.0 - vUv) * dims;
  float e = min(dEdge.x, dEdge.y);
  float lw = 0.012;
  float edge = 1.0 - smoothstep(lw, lw + fwidth(e) * 1.5, e);

  vec3 L = normalize(vec3(0.35, 1.0, 0.45));
  float shade = 0.5 + 0.5 * max(dot(n, L), 0.0);
  shade *= mix(0.78, 1.0, vLocalY + 0.5);

  // base colors stay below the bloom threshold; only deliberate glow blooms
  vec3 base = vColor * shade * 0.86;
  vec3 edgeCol = vColor * 1.06 + vec3(0.03);
  vec3 col = mix(base, edgeCol, edge * 0.85);
  col += vColor * vGlow * 1.05;

  float alpha = clamp(vAlpha + edge * vAlpha * 2.6, 0.0, 1.0);
  if (alpha < 0.004) discard;
  if (uPass < 0.5) { if (alpha < 0.999) discard; }
  else { if (alpha >= 0.999) discard; }

  float fog = smoothstep(uFogNear, uFogFar, vDepth);
  col = mix(col, uFogColor, fog);
  gl_FragColor = vec4(col, alpha * (1.0 - fog * 0.6));
}
`

export class CellField {
  readonly capacity: number
  readonly group = new THREE.Group()
  private cells: (Cell | null)[] = []
  private free: number[] = []
  private high = 0
  private nextId = 1
  private solid: THREE.InstancedMesh
  private ghost: THREE.InstancedMesh
  private aColor: THREE.InstancedBufferAttribute
  private aAlpha: THREE.InstancedBufferAttribute
  private aGlow: THREE.InstancedBufferAttribute
  readonly uniforms = {
    uPass: { value: 0 },
    uFogColor: { value: new THREE.Color('#07080b') },
    uFogNear: { value: 30 },
    uFogFar: { value: 80 },
  }

  constructor(capacity = 24000) {
    this.capacity = capacity
    const geo = new THREE.BoxGeometry(1, 1, 1)
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    this.aGlow = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
    for (const a of [this.aColor, this.aAlpha, this.aGlow]) a.setUsage(THREE.DynamicDrawUsage)
    geo.setAttribute('aColor', this.aColor)
    geo.setAttribute('aAlpha', this.aAlpha)
    geo.setAttribute('aGlow', this.aGlow)

    const mk = (pass: number) =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { ...this.uniforms, uPass: { value: pass } },
        transparent: pass === 1,
        depthWrite: pass === 0,
      })
    this.solid = new THREE.InstancedMesh(geo, mk(0), capacity)
    this.ghost = new THREE.InstancedMesh(geo, mk(1), capacity)
    this.ghost.instanceMatrix = this.solid.instanceMatrix
    this.solid.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.ghost.renderOrder = 2
    for (const m of [this.solid, this.ghost]) {
      m.frustumCulled = false
      m.count = 0
      this.group.add(m)
    }
  }

  setFog(near: number, far: number) {
    this.uniforms.uFogNear.value = near
    this.uniforms.uFogFar.value = far
    ;(this.solid.material as THREE.ShaderMaterial).uniforms.uFogNear.value = near
    ;(this.solid.material as THREE.ShaderMaterial).uniforms.uFogFar.value = far
    ;(this.ghost.material as THREE.ShaderMaterial).uniforms.uFogNear.value = near
    ;(this.ghost.material as THREE.ShaderMaterial).uniforms.uFogFar.value = far
  }

  get size() {
    return this.high - this.free.length
  }

  alloc(init: CellInit = {}): Cell {
    let slot: number
    if (this.free.length) slot = this.free.pop()!
    else {
      if (this.high >= this.capacity) throw new Error('CellField capacity exceeded')
      slot = this.high++
    }
    const { color, ...rest } = init
    const c: Cell = {
      id: this.nextId++,
      x: 0, y: 0, z: 0,
      w: 1, h: 1, d: 1,
      r: color ? color[0] : 0.5,
      g: color ? color[1] : 0.5,
      b: color ? color[2] : 0.5,
      a: 1,
      glow: 0,
      p: 0,
      ...rest,
    }
    ;(c as any)._slot = slot
    this.cells[slot] = c
    return c
  }

  release(c: Cell | Cell[]) {
    const list = Array.isArray(c) ? c : [c]
    for (const cell of list) {
      const slot = (cell as any)._slot as number | undefined
      if (slot === undefined || this.cells[slot] !== cell) continue
      this.cells[slot] = null
      ;(cell as any)._slot = undefined
      this.free.push(slot)
    }
  }

  clear() {
    this.cells = []
    this.free = []
    this.high = 0
  }

  sync() {
    const m = this.solid.instanceMatrix.array as Float32Array
    const col = this.aColor.array as Float32Array
    const al = this.aAlpha.array as Float32Array
    const gl = this.aGlow.array as Float32Array
    for (let i = 0; i < this.high; i++) {
      const c = this.cells[i]
      const o = i * 16
      if (!c || c.a <= 0.001) {
        m[o] = 0; m[o + 5] = 0; m[o + 10] = 0; m[o + 15] = 1
        al[i] = 0
        continue
      }
      let x = c.x, y = c.y, z = c.z
      if (c.path) {
        const q = c.path(c.p)
        x = q[0]; y = q[1]; z = q[2]
      }
      m[o] = Math.max(c.w, 1e-4); m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0
      m[o + 4] = 0; m[o + 5] = Math.max(c.h, 1e-4); m[o + 6] = 0; m[o + 7] = 0
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = Math.max(c.d, 1e-4); m[o + 11] = 0
      m[o + 12] = x; m[o + 13] = y + c.h / 2; m[o + 14] = z; m[o + 15] = 1
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b
      al[i] = c.a
      gl[i] = c.glow
    }
    this.solid.count = this.high
    this.ghost.count = this.high
    this.solid.instanceMatrix.needsUpdate = true
    this.aColor.needsUpdate = true
    this.aAlpha.needsUpdate = true
    this.aGlow.needsUpdate = true
  }
}

/** Set a cell's color from an RGB triple. */
export function paint(c: Cell, rgb: RGB) {
  c.r = rgb[0]; c.g = rgb[1]; c.b = rgb[2]
}
