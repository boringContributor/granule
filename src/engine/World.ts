import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { CellField } from './Cells'
import type { RGB } from './palette'

export interface Rig {
  tx: number
  ty: number
  tz: number
  /** azimuth around Y */
  theta: number
  /** polar angle from +Y */
  phi: number
  radius: number
}

/** A fadeable line object; `o` is synced into material opacity every frame. */
export interface LineHandle {
  obj: THREE.LineSegments | THREE.Line
  o: number
  r: number
  g: number
  b: number
}

/** A DOM label pinned to a 3D position; position/opacity are synced each frame. */
export interface Label {
  el: HTMLDivElement
  obj: CSS2DObject
  x: number
  y: number
  z: number
  o: number
  set(html: string): void
}

const FLOOR_FRAG = /* glsl */ `
varying vec3 vW;
uniform vec3 uColor;
uniform vec3 uCenter;
void main() {
  vec2 p = vW.xz;
  vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  vec2 g5 = abs(fract(p / 5.0 - 0.5) - 0.5) / fwidth(p / 5.0);
  float line5 = 1.0 - min(min(g5.x, g5.y), 1.0);
  float d = length(p - uCenter.xz);
  float fade = 1.0 - smoothstep(6.0, 34.0, d);
  float glow = (1.0 - smoothstep(0.0, 26.0, d)) * 0.05;
  float a = (line * 0.05 + line5 * 0.07) * fade;
  gl_FragColor = vec4(uColor * (0.6 + line5 * 0.4) + glow, a + glow * 0.6);
}
`

export class World {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly cells: CellField
  readonly dyn = new THREE.Group()
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private labelRenderer: CSS2DRenderer
  private lines: LineHandle[] = []
  private labels: Label[] = []
  private ticks = new Set<(t: number, dt: number) => void>()
  private floorMat: THREE.ShaderMaterial
  private raf = 0
  private last = performance.now()
  private ro: ResizeObserver
  /** the authored camera position, animated by scenes */
  readonly rig: Rig = { tx: 0, ty: 0, tz: 0, theta: -0.55, phi: 0.95, radius: 24 }
  /** the viewer's own orbit offset (drag / wheel) */
  private user = { theta: 0, phi: 0, zoom: 1 }
  private userTarget = { theta: 0, phi: 0, zoom: 1 }
  drift = true
  private time = 0
  /** fraction of the viewport to shift the framing by (positive y = content moves up) */
  frame = { x: 0.02, y: 0.09 }

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor('#07080b')
    host.appendChild(this.renderer.domElement)
    this.renderer.domElement.className = 'world-canvas'

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 400)
    this.scene.background = new THREE.Color('#07080b')

    this.cells = new CellField()
    this.cells.setFog(36, 90)
    this.scene.add(this.cells.group)
    this.scene.add(this.dyn)

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      (this.floorMat = new THREE.ShaderMaterial({
        vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: FLOOR_FRAG,
        uniforms: { uColor: { value: new THREE.Color('#6f7d99') }, uCenter: { value: new THREE.Vector3() } },
        transparent: true,
        depthWrite: false,
      })),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -0.01
    floor.renderOrder = -1
    this.scene.add(floor)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.48, 0.38, 0.95)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    this.labelRenderer = new CSS2DRenderer()
    this.labelRenderer.domElement.className = 'world-labels'
    host.appendChild(this.labelRenderer.domElement)

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
    this.bindPointer()
    this.loop = this.loop.bind(this)
    this.raf = requestAnimationFrame(this.loop)
  }

  private resize() {
    const w = this.host.clientWidth || 1
    const h = this.host.clientHeight || 1
    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
    this.labelRenderer.setSize(w, h)
    this.camera.aspect = w / h
    // keep framing similar on narrow screens
    this.camera.fov = w / h < 1 ? 52 : 34
    // frame the scene a little above center: the caption card covers the bottom of the stage
    this.camera.setViewOffset(w, h, w * this.frame.x, h * this.frame.y, w, h)
    this.camera.updateProjectionMatrix()
  }

  private bindPointer() {
    const el = this.renderer.domElement
    let down: { x: number; y: number; t: number; p: number } | null = null
    el.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: this.userTarget.theta, p: this.userTarget.phi }
      el.setPointerCapture(e.pointerId)
    })
    el.addEventListener('pointermove', (e) => {
      if (!down) return
      this.userTarget.theta = down.t - (e.clientX - down.x) * 0.005
      this.userTarget.phi = Math.max(-0.75, Math.min(0.5, down.p - (e.clientY - down.y) * 0.004))
    })
    const up = () => (down = null)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('dblclick', () => (this.userTarget = { theta: 0, phi: 0, zoom: 1 }))
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        this.userTarget.zoom = Math.max(0.35, Math.min(2.4, this.userTarget.zoom * Math.exp(e.deltaY * 0.0012)))
      },
      { passive: false },
    )
  }

  /** Shift the framing, e.g. to keep content clear of a side panel. */
  setFrame(x: number, y: number) {
    this.frame = { x, y }
    this.resize()
  }

  onTick(fn: (t: number, dt: number) => void) {
    this.ticks.add(fn)
    return () => this.ticks.delete(fn)
  }

  // ---------- lines ----------

  /** Wireframe box outline with bottom at y. */
  box(x: number, y: number, z: number, w: number, h: number, d: number, color: RGB, o = 0): LineHandle {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d))
    const mat = new THREE.LineBasicMaterial({ transparent: true, opacity: o, depthWrite: false })
    const obj = new THREE.LineSegments(geo, mat)
    obj.position.set(x, y + h / 2, z)
    return this.addLine(obj, color, o)
  }

  /** Flat rectangle outline on the floor (or at height y). */
  rect(x: number, y: number, z: number, w: number, d: number, color: RGB, o = 0, dashed = false): LineHandle {
    const pts = [
      new THREE.Vector3(-w / 2, 0, -d / 2),
      new THREE.Vector3(w / 2, 0, -d / 2),
      new THREE.Vector3(w / 2, 0, d / 2),
      new THREE.Vector3(-w / 2, 0, d / 2),
      new THREE.Vector3(-w / 2, 0, -d / 2),
    ]
    const geo = new THREE.BufferGeometry().setFromPoints(pts)
    const mat = dashed
      ? new THREE.LineDashedMaterial({ transparent: true, opacity: o, dashSize: 0.18, gapSize: 0.12, depthWrite: false })
      : new THREE.LineBasicMaterial({ transparent: true, opacity: o, depthWrite: false })
    const obj = new THREE.Line(geo, mat)
    if (dashed) obj.computeLineDistances()
    obj.position.set(x, y, z)
    return this.addLine(obj, color, o)
  }

  /** Polyline through points. */
  polyline(points: [number, number, number][], color: RGB, o = 0, dashed = false): LineHandle {
    const geo = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)))
    const mat = dashed
      ? new THREE.LineDashedMaterial({ transparent: true, opacity: o, dashSize: 0.2, gapSize: 0.14, depthWrite: false })
      : new THREE.LineBasicMaterial({ transparent: true, opacity: o, depthWrite: false })
    const obj = new THREE.Line(geo, mat)
    if (dashed) obj.computeLineDistances()
    return this.addLine(obj, color, o)
  }

  /** Arc between two points (quadratic, lifted by `lift`). Returns line + sampler for packets. */
  arc(a: [number, number, number], b: [number, number, number], lift: number, color: RGB, o = 0, dashed = true) {
    const path = arcPath(a, b, lift)
    const pts: [number, number, number][] = []
    for (let i = 0; i <= 48; i++) pts.push(path(i / 48))
    const line = this.polyline(pts, color, o, dashed)
    return { line, path }
  }

  private addLine(obj: THREE.LineSegments | THREE.Line, color: RGB, o: number): LineHandle {
    const h: LineHandle = { obj, o, r: color[0], g: color[1], b: color[2] }
    obj.renderOrder = 3
    this.dyn.add(obj)
    this.lines.push(h)
    return h
  }

  removeLine(h: LineHandle) {
    this.dyn.remove(h.obj)
    h.obj.geometry.dispose()
    ;(h.obj.material as THREE.Material).dispose()
    this.lines = this.lines.filter((l) => l !== h)
  }

  // ---------- labels ----------

  label(html: string, x: number, y: number, z: number, cls = '', o = 0): Label {
    const el = document.createElement('div')
    el.className = `lbl ${cls}`
    el.innerHTML = html
    const obj = new CSS2DObject(el)
    obj.position.set(x, y, z)
    this.dyn.add(obj)
    const l: Label = {
      el,
      obj,
      x,
      y,
      z,
      o,
      set(h: string) {
        if (el.innerHTML !== h) el.innerHTML = h
      },
    }
    this.labels.push(l)
    return l
  }

  removeLabel(l: Label) {
    this.dyn.remove(l.obj)
    l.el.remove()
    this.labels = this.labels.filter((x) => x !== l)
  }

  /** Remove everything a scene created. */
  clear() {
    this.cells.clear()
    for (const l of this.lines) {
      l.obj.geometry.dispose()
      ;(l.obj.material as THREE.Material).dispose()
    }
    for (const l of this.labels) l.el.remove()
    this.lines = []
    this.labels = []
    this.dyn.clear()
    this.ticks.clear()
  }

  setBloom(strength: number) {
    this.bloom.strength = strength
  }

  /** Project a world point to CSS pixels relative to the host. */
  project(x: number, y: number, z: number) {
    const v = new THREE.Vector3(x, y, z).project(this.camera)
    return { x: ((v.x + 1) / 2) * this.host.clientWidth, y: ((1 - v.y) / 2) * this.host.clientHeight }
  }

  private loop(now: number) {
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(0.05, (now - this.last) / 1000)
    this.last = now
    this.time += dt
    for (const fn of this.ticks) fn(this.time, dt)

    // ease the viewer offset toward its target
    const k = 1 - Math.pow(0.0015, dt)
    this.user.theta += (this.userTarget.theta - this.user.theta) * k
    this.user.phi += (this.userTarget.phi - this.user.phi) * k
    this.user.zoom += (this.userTarget.zoom - this.user.zoom) * k

    const r = this.rig
    const drift = this.drift ? Math.sin(this.time * 0.11) * 0.06 : 0
    const theta = r.theta + this.user.theta + drift
    const phi = Math.max(0.12, Math.min(1.45, r.phi + this.user.phi))
    const rad = r.radius * this.user.zoom
    this.camera.position.set(
      r.tx + rad * Math.sin(phi) * Math.sin(theta),
      r.ty + rad * Math.cos(phi),
      r.tz + rad * Math.sin(phi) * Math.cos(theta),
    )
    this.camera.lookAt(r.tx, r.ty, r.tz)
    this.floorMat.uniforms.uCenter.value.set(r.tx, 0, r.tz)

    for (const l of this.lines) {
      const m = l.obj.material as THREE.LineBasicMaterial
      m.opacity = l.o
      m.color.setRGB(l.r, l.g, l.b)
      l.obj.visible = l.o > 0.003
    }
    for (const l of this.labels) {
      l.obj.position.set(l.x, l.y, l.z)
      const o = Math.max(0, Math.min(1, l.o))
      l.el.style.opacity = String(o)
      l.obj.visible = o > 0.01
    }

    this.cells.sync()
    this.composer.render()
    this.labelRenderer.render(this.scene, this.camera)
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.clear()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.labelRenderer.domElement.remove()
  }
}

export function arcPath(a: [number, number, number], b: [number, number, number], lift: number) {
  const mid: [number, number, number] = [(a[0] + b[0]) / 2, Math.max(a[1], b[1]) + lift, (a[2] + b[2]) / 2]
  return (t: number): [number, number, number] => {
    const u = 1 - t
    return [
      u * u * a[0] + 2 * u * t * mid[0] + t * t * b[0],
      u * u * a[1] + 2 * u * t * mid[1] + t * t * b[1],
      u * u * a[2] + 2 * u * t * mid[2] + t * t * b[2],
    ]
  }
}
