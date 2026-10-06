import { useEffect, useRef, useState } from 'react'
import type { Player, PlayerState } from '../engine/Player'
import { Next, Pause, Play, Prev, Restart } from './icons'
import { highlightSql } from './sql-highlight'

const SPEEDS = [0.5, 1, 2]
const KEY_STORE = 'granule.keys-used'
/** After this many key presses the hint has done its job and stays hidden. */
const HINT_UNTIL = 3

type Flash = 'prev' | 'toggle' | 'next' | 'restart' | null

const readUses = () => {
  try {
    return Number(localStorage.getItem(KEY_STORE) || 0)
  } catch {
    return 0
  }
}

/** Light up the button a key maps to, and count how often the keyboard is used. */
function useKeyFeedback() {
  const [flash, setFlash] = useState<Flash>(null)
  const [uses, setUses] = useState(readUses)
  useEffect(() => {
    let t = 0
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.('textarea, input, select')) return
      const f: Flash = e.key === 'ArrowRight' ? 'next' : e.key === 'ArrowLeft' ? 'prev' : e.key === ' ' ? 'toggle' : e.key === 'r' ? 'restart' : null
      if (!f) return
      setFlash(f)
      clearTimeout(t)
      t = window.setTimeout(() => setFlash(null), 260)
      setUses((n) => {
        const next = n + 1
        try {
          localStorage.setItem(KEY_STORE, String(next))
        } catch {
          /* storage unavailable */
        }
        return next
      })
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(t)
    }
  }, [])
  return { flash, showHint: uses < HINT_UNTIL }
}

export function Caption({ state, player, compact, side }: { state: PlayerState; player: Player; compact?: boolean; side?: boolean }) {
  const { step, index, count, scene } = state
  const { flash, showHint } = useKeyFeedback()
  const controls = useRef<HTMLDivElement>(null)
  const countdown = useRef<HTMLSpanElement>(null)

  // autoplay countdown: written straight to the DOM so it doesn't re-render React every frame
  useEffect(
    () =>
      player.onHold((h) => {
        const el = controls.current
        if (!el) return
        el.classList.toggle('holding', !!h)
        el.style.setProperty('--hold', String(h ? h.p : 0))
        if (countdown.current) countdown.current.textContent = h ? `next in ${Math.max(1, Math.ceil(h.left))}s` : ''
      }),
    [player],
  )

  if (!scene || !step) return null
  const fl = (f: Flash) => (flash === f ? ' flash' : '')
  return (
    <div className={`caption ${compact ? 'compact' : ''} ${side ? 'side' : ''}`}>
      <div className="caption-head">
        <span className="caption-kicker">{scene.title}</span>
        <div className="dots">
          {Array.from({ length: count }, (_, i) => (
            <button
              key={i}
              className={`dot ${i === index ? 'on' : ''} ${i < index ? 'done' : ''}`}
              onClick={() => player.goto(i, true)}
              aria-label={`Step ${i + 1}`}
            />
          ))}
        </div>
        {scene.docs && !compact && (
          <a className="docs-link" href={scene.docs} target="_blank" rel="noreferrer" title="Read this concept in the ClickHouse docs">
            docs ↗
          </a>
        )}
        <span className="caption-count">
          {String(index + 1).padStart(2, '0')}
          <em> / {String(count).padStart(2, '0')}</em>
        </span>
      </div>
      <div className="caption-body" key={`${scene.id}-${index}`}>
        <h2>{step.title}</h2>
        <p dangerouslySetInnerHTML={{ __html: step.body }} />
        {step.code && <pre className="sql" dangerouslySetInnerHTML={{ __html: highlightSql(step.code) }} />}
      </div>
      {!compact && (
        <div className={`controls ${state.playing ? '' : 'paused'}`} ref={controls}>
          <button className={`ctl${fl('restart')}`} onClick={() => player.restart()} title="Restart (R)">
            <Restart />
          </button>
          <button className={`ctl${fl('prev')}`} onClick={() => player.prev()} disabled={index <= 0} title="Previous (←)">
            <Prev />
          </button>
          <button className={`ctl primary${fl('toggle')}`} onClick={() => player.toggle()} title="Play / pause (space)">
            {state.playing ? <Pause /> : <Play />}
          </button>
          <button className={`ctl next${fl('next')}`} onClick={() => player.next()} disabled={index >= count - 1} title="Next (→)">
            <Next />
          </button>
          <span className="countdown" ref={countdown} />
          <span className={`keys ${showHint ? '' : 'gone'}`} aria-hidden>
            <kbd>←</kbd>
            <kbd>→</kbd> step <kbd className="wide">space</kbd> pause
          </span>
          <div className="speed">
            {SPEEDS.map((s) => (
              <button key={s} className={state.speed === s ? 'on' : ''} onClick={() => player.setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
          <div className={`progress ${state.busy ? 'busy' : ''}`}>
            <i />
          </div>
        </div>
      )}
    </div>
  )
}
