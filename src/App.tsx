import { useEffect, useRef, useState } from 'react'
import { World } from './engine/World'
import { Player, type PlayerState } from './engine/Player'
import { LESSONS, SECTIONS, findScene } from './scenes'
import { makeQueryLab, DEFAULT_SQL } from './scenes/queryLab'
import { Caption } from './ui/Caption'
import { Stats } from './ui/Stats'
import { QueryPanel } from './ui/QueryPanel'
import { LivePanel } from './ui/LivePanel'
import { liveIdleScene } from './scenes/live'
import { Bolt, Logo, Plug } from './ui/icons'

type Route = { kind: 'scene'; id: string } | { kind: 'lab' } | { kind: 'live' }

function parseRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '')
  if (h.startsWith('lab')) return { kind: 'lab' }
  if (h.startsWith('live')) return { kind: 'live' }
  return { kind: 'scene', id: h || 'overview' }
}

const params = new URLSearchParams(location.search)
const RECORD = params.has('record')

export function App() {
  const stageRef = useRef<HTMLDivElement>(null)
  const [player, setPlayer] = useState<Player | null>(null)
  const [state, setState] = useState<PlayerState | null>(null)
  const [route, setRoute] = useState<Route>(parseRoute)
  const [sql, setSql] = useState(() => {
    try {
      return params.get('q') || localStorage.getItem('granule.sql') || DEFAULT_SQL
    } catch {
      return DEFAULT_SQL
    }
  })

  useEffect(() => {
    const world = new World(stageRef.current!)
    if (RECORD) world.drift = false
    const p = new Player(world)
    const off = p.subscribe(setState)
    setPlayer(p)
    ;(window as any).__granule = { world, player: p }
    return () => {
      off()
      world.dispose()
    }
  }, [])

  useEffect(() => {
    const on = () => setRoute(parseRoute())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  // load whatever the route points at
  useEffect(() => {
    if (!player) return
    const side = !RECORD && (route.kind === 'lab' || route.kind === 'live') && window.innerWidth > 860
    player.world.setFrame(side ? (route.kind === 'live' ? -0.17 : -0.08) : RECORD ? 0 : 0.02, side ? 0.04 : RECORD ? 0.1 : 0.09)
    if (route.kind === 'scene') player.load(findScene(route.id) ?? LESSONS[0], { autoplay: true })
    else if (route.kind === 'lab') player.load(makeQueryLab(sql), { autoplay: true })
    // live mode shows an idle field until the panel loads a table into the player
    else player.load(liveIdleScene, { autoplay: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, route])

  useEffect(() => {
    if (!player) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('textarea, input')) return
      if (e.key === 'ArrowRight') player.next()
      else if (e.key === 'ArrowLeft') player.prev()
      else if (e.key === ' ') {
        e.preventDefault()
        player.toggle()
      } else if (e.key === 'r') player.restart()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [player])

  const runSql = (q: string) => {
    setSql(q)
    try {
      localStorage.setItem('granule.sql', q)
    } catch {
      /* storage unavailable */
    }
    if (route.kind !== 'lab') location.hash = '#/lab'
    else player?.load(makeQueryLab(q), { autoplay: true })
  }

  const current = route.kind === 'scene' ? findScene(route.id) ?? LESSONS[0] : null
  const active = current ? current.id : route.kind

  return (
    <div className={`app ${RECORD ? 'record' : ''}`}>
      <div className="stage" ref={stageRef} />
      <div className="vignette" />

      {!RECORD && (
        <nav className="nav">
          <a className="brand" href="#/overview">
            <span className="brand-mark">
              <Logo />
            </span>
            <span className="brand-name">
              granule
            </span>
          </a>
          <p className="tagline">See what ClickHouse is actually doing.</p>

          {SECTIONS.map((sec) => (
            <div key={sec.title}>
              <div className="nav-section">{sec.title}</div>
              {sec.scenes.map((s) => (
                <a key={s.id} href={`#/${s.id}`} className={`nav-item ${current?.id === s.id ? 'on' : ''}`}>
                  <span className="nav-num">{String(LESSONS.indexOf(s)).padStart(2, '0')}</span>
                  <span className="nav-text">
                    <span className="nav-title">{s.title}</span>
                    <span className="nav-sub">{s.kicker}</span>
                  </span>
                </a>
              ))}
            </div>
          ))}

          <div className="nav-section">Explore</div>
          <a href="#/lab" className={`nav-item ${active === 'lab' ? 'on' : ''}`}>
            <span className="nav-num">
              <Bolt />
            </span>
            <span className="nav-text">
              <span className="nav-title">Query lab</span>
              <span className="nav-sub">Paste SQL, watch it execute</span>
            </span>
          </a>
          <a href="#/live" className={`nav-item ${active === 'live' ? 'on' : ''}`}>
            <span className="nav-num">
              <Plug />
            </span>
            <span className="nav-text">
              <span className="nav-title">Live cluster</span>
              <span className="nav-sub">Map your real parts & merges</span>
            </span>
          </a>

          <div className="nav-foot">
            <span className="hint">drag to orbit · scroll to zoom · ← → step</span>
          </div>
        </nav>
      )}

      {!RECORD && (
        <div className="mbar">
          <a className="brand" href="#/overview">
            <span className="brand-mark">
              <Logo />
            </span>
            <span className="brand-name">
              granule
            </span>
          </a>
          <select value={active} onChange={(e) => (location.hash = `#/${e.target.value}`)} aria-label="Choose a lesson">
            {SECTIONS.map((sec) => (
              <optgroup key={sec.title} label={sec.title}>
                {sec.scenes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </optgroup>
            ))}
            <option value="lab">Query lab</option>
            <option value="live">Live cluster</option>
          </select>
        </div>
      )}

      {state && route.kind !== 'live' && <Stats stats={state.stats} />}
      {state && player && route.kind !== 'live' && <Caption state={state} player={player} compact={RECORD} side={route.kind === 'lab' && !RECORD} />}
      {player && route.kind === 'lab' && !RECORD && <QueryPanel sql={sql} onRun={runSql} />}
      {player && route.kind === 'live' && <LivePanel player={player} state={state} />}
    </div>
  )
}
