const KW =
  /\b(SELECT|FROM|WHERE|AND|OR|NOT|IN|BETWEEN|GROUP|BY|ORDER|LIMIT|AS|CREATE|TABLE|MATERIALIZED|VIEW|TO|ENGINE|PARTITION|PRIMARY|KEY|INSERT|INTO|VALUES|DESC|ASC|ON|CLUSTER|SETTINGS|FINAL|PREWHERE|HAVING|WITH|DISTINCT|INDEX|TYPE|GRANULARITY|LIKE|IS|NULL)\b/gi
const FN = /\b([a-zA-Z_][a-zA-Z0-9_]*)(?=\()/g
const STR = /('(?:[^'\\]|\\.)*')/g
const NUM = /\b(\d+(?:\.\d+)?)\b/g

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Tiny SQL highlighter: strings first, then everything else outside of strings. */
export function highlightSql(sql: string): string {
  const parts = sql.split(STR)
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return `<span class="s">${esc(p)}</span>`
      return esc(p)
        .replace(FN, '<span class="f">$1</span>')
        .replace(KW, (m) => `<span class="k">${m}</span>`)
        .replace(NUM, '<span class="n">$1</span>')
    })
    .join('')
}
