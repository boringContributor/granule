/**
 * A deliberately small SQL reader. It understands the shape of analytical SELECTs well enough
 * to know which columns are touched, what the WHERE clause constrains, and whether the query
 * aggregates — which is all the visualizer needs. Anything it can't interpret is kept as
 * "unknown" and treated conservatively (it never causes data to be skipped).
 */

export type Expr =
  | { k: 'col'; name: string }
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'fn'; name: string; args: Expr[] }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'and' | 'or'; items: Expr[] }
  | { k: 'not'; e: Expr }
  | { k: 'in'; e: Expr; list: Expr[]; neg: boolean }
  | { k: 'between'; e: Expr; lo: Expr; hi: Expr; neg: boolean }
  | { k: 'like'; e: Expr; pat: Expr; neg: boolean }
  | { k: 'interval'; v: Expr; unit: string }
  | { k: 'star' }
  | { k: 'unknown'; text: string }

export interface Query {
  select: Expr[]
  from: string
  where: Expr | null
  prewhere: Expr | null
  groupBy: Expr[]
  orderBy: Expr[]
  limit: number | null
  final: boolean
  /** every identifier that looks like a column, in order of appearance */
  idents: string[]
  /** names introduced with AS (or a bare alias) */
  aliases: string[]
}

type Tok = { t: 'id' | 'num' | 'str' | 'op' | 'kw'; v: string }

const KEYWORDS = new Set(
  'SELECT FROM WHERE PREWHERE AND OR NOT IN BETWEEN LIKE ILIKE GROUP BY ORDER LIMIT AS DESC ASC FINAL SETTINGS FORMAT HAVING INTERVAL IS NULL DISTINCT WITH OFFSET'.split(
    ' ',
  ),
)

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === "'") {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== "'") {
        if (src[j] === '\\') j++
        s += src[j++]
      }
      out.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/i.exec(src.slice(i))!
      out.push({ t: 'num', v: m[0] })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      const up = m[0].toUpperCase()
      out.push(KEYWORDS.has(up) ? { t: 'kw', v: up } : { t: 'id', v: m[0] })
      i += m[0].length
      continue
    }
    if (c === '`' || c === '"') {
      const j = src.indexOf(c, i + 1)
      out.push({ t: 'id', v: src.slice(i + 1, j < 0 ? undefined : j) })
      i = j < 0 ? src.length : j + 1
      continue
    }
    const two = src.slice(i, i + 2)
    if (['<=', '>=', '!=', '<>', '=='].includes(two)) {
      out.push({ t: 'op', v: two === '<>' ? '!=' : two === '==' ? '=' : two })
      i += 2
      continue
    }
    out.push({ t: 'op', v: c })
    i++
  }
  return out
}

export class SqlError extends Error {}

export function parseQuery(src: string): Query {
  const toks = lex(src.trim().replace(/;\s*$/, ''))
  let p = 0
  const idents: string[] = []
  const aliases: string[] = []
  const peek = (o = 0) => toks[p + o]
  const isKw = (v: string, o = 0) => peek(o)?.t === 'kw' && peek(o).v === v
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v
  const eat = () => toks[p++]
  const expectKw = (v: string) => {
    if (!isKw(v)) throw new SqlError(`Expected ${v}${peek() ? ` near “${peek().v}”` : ''}`)
    p++
  }
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new SqlError(`Expected “${v}”${peek() ? ` near “${peek().v}”` : ''}`)
    p++
  }

  const STOP = new Set(['FROM', 'WHERE', 'PREWHERE', 'GROUP', 'ORDER', 'LIMIT', 'SETTINGS', 'FORMAT', 'HAVING', 'FINAL', 'OFFSET'])

  function expr(): Expr {
    return orExpr()
  }
  function orExpr(): Expr {
    const items = [andExpr()]
    while (isKw('OR')) {
      p++
      items.push(andExpr())
    }
    return items.length === 1 ? items[0] : { k: 'or', items }
  }
  function andExpr(): Expr {
    const items = [notExpr()]
    while (isKw('AND')) {
      p++
      items.push(notExpr())
    }
    return items.length === 1 ? items[0] : { k: 'and', items }
  }
  function notExpr(): Expr {
    if (isKw('NOT')) {
      p++
      return { k: 'not', e: notExpr() }
    }
    return cmp()
  }
  function cmp(): Expr {
    const l = add()
    const t = peek()
    if (t?.t === 'op' && ['=', '!=', '<', '>', '<=', '>='].includes(t.v)) {
      p++
      return { k: 'bin', op: t.v, l, r: add() }
    }
    let neg = false
    if (isKw('NOT') && (isKw('IN', 1) || isKw('BETWEEN', 1) || isKw('LIKE', 1) || isKw('ILIKE', 1))) {
      p++
      neg = true
    }
    if (isKw('IN')) {
      p++
      expectOp('(')
      const list: Expr[] = []
      if (!isOp(')')) {
        list.push(expr())
        while (isOp(',')) {
          p++
          list.push(expr())
        }
      }
      expectOp(')')
      return { k: 'in', e: l, list, neg }
    }
    if (isKw('BETWEEN')) {
      p++
      const lo = add()
      expectKw('AND')
      const hi = add()
      return { k: 'between', e: l, lo, hi, neg }
    }
    if (isKw('LIKE') || isKw('ILIKE')) {
      p++
      return { k: 'like', e: l, pat: add(), neg }
    }
    if (isKw('IS')) {
      p++
      if (isKw('NOT')) p++
      expectKw('NULL')
      return { k: 'unknown', text: 'IS NULL' }
    }
    return l
  }
  function add(): Expr {
    let l = mul()
    while (isOp('+') || isOp('-')) {
      const op = eat().v
      l = { k: 'bin', op, l, r: mul() }
    }
    return l
  }
  function mul(): Expr {
    let l = primary()
    while (isOp('*') || isOp('/') || isOp('%')) {
      // `*` right after SELECT is handled by primary; here it is multiplication
      const op = eat().v
      l = { k: 'bin', op, l, r: primary() }
    }
    return l
  }
  function primary(): Expr {
    const t = peek()
    if (!t) throw new SqlError('Unexpected end of query')
    if (t.t === 'num') {
      p++
      return { k: 'num', v: parseFloat(t.v) }
    }
    if (t.t === 'str') {
      p++
      return { k: 'str', v: t.v }
    }
    if (t.t === 'op' && t.v === '(') {
      p++
      const e = expr()
      expectOp(')')
      return e
    }
    if (t.t === 'op' && t.v === '-') {
      p++
      const e = primary()
      return e.k === 'num' ? { k: 'num', v: -e.v } : { k: 'bin', op: '-', l: { k: 'num', v: 0 }, r: e }
    }
    if (t.t === 'op' && t.v === '*') {
      p++
      return { k: 'star' }
    }
    if (t.t === 'kw' && t.v === 'INTERVAL') {
      p++
      const v = primary()
      const unit = eat()?.v?.toUpperCase() ?? 'DAY'
      return { k: 'interval', v, unit }
    }
    if (t.t === 'kw' && t.v === 'NULL') {
      p++
      return { k: 'unknown', text: 'NULL' }
    }
    if (t.t === 'id') {
      p++
      if (isOp('(')) {
        p++
        const args: Expr[] = []
        if (isKw('DISTINCT')) p++
        if (!isOp(')')) {
          args.push(expr())
          while (isOp(',')) {
            p++
            args.push(expr())
          }
        }
        expectOp(')')
        // parametric aggregates: quantile(0.9)(x)
        if (isOp('(')) {
          p++
          const inner: Expr[] = []
          if (!isOp(')')) {
            inner.push(expr())
            while (isOp(',')) {
              p++
              inner.push(expr())
            }
          }
          expectOp(')')
          return { k: 'fn', name: t.v, args: inner }
        }
        return { k: 'fn', name: t.v, args }
      }
      let name = t.v
      if (isOp('.') && peek(1)?.t === 'id') {
        p++
        name = eat().v // table.column → column
      }
      idents.push(name)
      return { k: 'col', name }
    }
    throw new SqlError(`Unexpected “${t.v}”`)
  }
  function list(): Expr[] {
    const out = [aliased()]
    while (isOp(',')) {
      p++
      out.push(aliased())
    }
    return out
  }
  function aliased(): Expr {
    const e = expr()
    if (isKw('AS')) {
      p++
      const a = eat()
      if (a) aliases.push(a.v)
    } else if (peek()?.t === 'id' && !STOP.has(peek().v.toUpperCase())) {
      aliases.push(eat().v)
    }
    if (isKw('DESC') || isKw('ASC')) p++
    return e
  }

  if (isKw('WITH')) throw new SqlError('WITH clauses are not supported in the lab yet')
  expectKw('SELECT')
  if (isKw('DISTINCT')) p++
  const select = list()
  expectKw('FROM')
  const tt = eat()
  if (!tt || tt.t !== 'id') throw new SqlError('Expected a table name after FROM')
  let from = tt.v
  if (isOp('.') && peek(1)?.t === 'id') {
    p++
    from = eat().v
  }
  if (peek()?.t === 'id' && !STOP.has(peek().v.toUpperCase())) p++ // alias
  let final = false
  if (isKw('FINAL')) {
    p++
    final = true
  }
  let prewhere: Expr | null = null
  let where: Expr | null = null
  let groupBy: Expr[] = []
  let orderBy: Expr[] = []
  let limit: number | null = null
  while (peek()) {
    if (isKw('PREWHERE')) {
      p++
      prewhere = expr()
    } else if (isKw('WHERE')) {
      p++
      where = expr()
    } else if (isKw('GROUP')) {
      p += 1
      expectKw('BY')
      groupBy = list()
    } else if (isKw('HAVING')) {
      p++
      expr()
    } else if (isKw('ORDER')) {
      p++
      expectKw('BY')
      orderBy = list()
    } else if (isKw('LIMIT')) {
      p++
      const n = eat()
      limit = n?.t === 'num' ? parseInt(n.v, 10) : null
      if (isOp(',')) {
        p++
        const m = eat()
        limit = m?.t === 'num' ? parseInt(m.v, 10) : limit
      }
      if (isKw('OFFSET')) {
        p++
        eat()
      }
    } else if (isKw('SETTINGS') || isKw('FORMAT')) {
      break
    } else {
      throw new SqlError(`Unexpected “${peek().v}”`)
    }
  }
  return { select, from, where, prewhere, groupBy, orderBy, limit, final, idents, aliases }
}

export const AGGREGATES = new Set(
  'count sum avg min max uniq uniqExact uniqCombined uniqHLL12 any anyLast argMin argMax groupArray groupUniqArray quantile quantiles quantileExact quantileTiming median topK sumIf countIf avgIf minIf maxIf uniqIf stddevPop stddevSamp varPop varSamp corr sumMap'
    .split(' ')
    .map((s) => s.toLowerCase()),
)

export function hasAggregate(e: Expr): boolean {
  switch (e.k) {
    case 'fn':
      return AGGREGATES.has(e.name.toLowerCase()) || e.args.some(hasAggregate)
    case 'bin':
      return hasAggregate(e.l) || hasAggregate(e.r)
    default:
      return false
  }
}
