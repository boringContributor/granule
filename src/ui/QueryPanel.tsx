import { useEffect, useMemo, useState } from 'react'
import { demoDataset } from '../model/dataset'
import { planQuery } from '../model/plan'
import { PRESETS } from '../scenes/queryLab'
import { Bolt } from './icons'
import { highlightSql } from './sql-highlight'

const ds = demoDataset()

export function QueryPanel({ sql, onRun }: { sql: string; onRun: (q: string) => void }) {
  const [draft, setDraft] = useState(sql)
  useEffect(() => setDraft(sql), [sql])

  const check = useMemo(() => {
    try {
      const p = planQuery(draft, ds)
      return { ok: true as const, warnings: p.warnings }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  }, [draft])

  const run = () => check.ok && onRun(draft)

  return (
    <div className="panel">
      <h3>
        <Bolt /> Query lab
      </h3>
      <p className="sub">
        Write a query against the demo table <code>events</code> and watch which columns, partitions and granules ClickHouse actually reads.
      </p>
      <div className="editor">
        <pre className="sql" aria-hidden dangerouslySetInnerHTML={{ __html: highlightSql(draft) + '\n' }} />
        <textarea
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              run()
            }
          }}
          aria-label="SQL query"
        />
      </div>
      {!check.ok && <div className="err">{check.error}</div>}
      {check.ok && check.warnings.length > 0 && <div className="err" dangerouslySetInnerHTML={{ __html: check.warnings.join('<br/>') }} />}
      <div className="row">
        <button className="btn" onClick={run} disabled={!check.ok}>
          <Bolt /> Visualize
        </button>
        <span className="kbd">⌘ ↵</span>
      </div>
      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p.label} className="chip" onClick={() => onRun(p.sql)}>
            {p.label}
          </button>
        ))}
      </div>
      <details>
        <summary className="schema-toggle">Table schema</summary>
      <div className="schema">
        <div className="t">events · 3 shards · PARTITION BY toYYYYMM(event_date)</div>
        {ds.columns.map((c) => (
          <div key={c.name}>
            <span className={ds.orderBy.includes(c.name) ? 'pk' : ''}>{c.name}</span> <span className="t">{c.type}</span>
            {ds.orderBy.includes(c.name) && <span className="t"> · key #{ds.orderBy.indexOf(c.name) + 1}</span>}
          </div>
        ))}
      </div>
      </details>
    </div>
  )
}
