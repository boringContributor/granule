import { useEffect, useRef, useState } from 'react'
import type { Stat } from '../scenes/types'

function useCountUp(target: number, ms = 700) {
  const [v, setV] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    const start = performance.now()
    const a = from.current
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const e = 1 - Math.pow(1 - t, 3)
      const cur = a + (target - a) * e
      setV(cur)
      from.current = cur
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

function NumberValue({ value }: { value: number }) {
  const v = useCountUp(value)
  const decimals = Math.abs(value) < 10 && !Number.isInteger(value) ? 1 : 0
  return <>{v.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}</>
}

function StatCard({ s }: { s: Stat }) {
  return (
    <div className={`stat tone-${s.tone ?? 'mist'}`}>
      <div className="stat-label">{s.label}</div>
      <div className="stat-value">
        {typeof s.value === 'number' ? <NumberValue value={s.value} /> : s.value}
        {s.unit && <span className="stat-unit">{s.unit}</span>}
        {s.of !== undefined && <span className="stat-of">/ {typeof s.of === 'number' ? s.of.toLocaleString('en-US') : s.of}</span>}
      </div>
      {s.meter !== undefined && (
        <div className="stat-meter">
          <i style={{ width: `${Math.max(1.5, Math.min(100, s.meter * 100))}%` }} />
        </div>
      )}
    </div>
  )
}

export function Stats({ stats }: { stats: Stat[] | null }) {
  if (!stats || stats.length === 0) return null
  return (
    <div className="stats">
      {stats.map((s) => (
        <StatCard key={s.label} s={s} />
      ))}
    </div>
  )
}
