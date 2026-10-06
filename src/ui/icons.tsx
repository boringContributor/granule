const s = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const Play = () => (
  <svg {...s}>
    <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
  </svg>
)
export const Pause = () => (
  <svg {...s}>
    <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
  </svg>
)
export const Prev = () => (
  <svg {...s}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
)
export const Next = () => (
  <svg {...s}>
    <path d="M9 18l6-6-6-6" />
  </svg>
)
export const Restart = () => (
  <svg {...s}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
)
export const Bolt = () => (
  <svg {...s}>
    <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
  </svg>
)
export const Plug = () => (
  <svg {...s}>
    <path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4" />
  </svg>
)
export const Github = () => (
  <svg {...s} strokeWidth={1.8}>
    <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
  </svg>
)
export const Logo = () => (
  <svg width="22" height="22" viewBox="0 0 32 32">
    {[0, 1, 2].flatMap((r) =>
      [0, 1, 2].map((c) => {
        const lit = (r === 1 && c > 0) || (r === 2 && c === 1)
        return <rect key={`${r}${c}`} x={4 + c * 8.5} y={4 + r * 8.5} width="6.5" height="6.5" rx="1.6" fill="currentColor" opacity={lit ? 1 : 0.22} />
      }),
    )}
  </svg>
)
