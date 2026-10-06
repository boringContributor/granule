import type { SceneDef } from './types'

/** Placeholder for a lesson that is being written. */
export const stub = (id: string, title: string, kicker: string, docs: string): SceneDef => ({
  id,
  title,
  kicker,
  blurb: '',
  docs,
  create(ctx) {
    ctx.stats(null)
    return { steps: [{ title, body: 'This lesson is being built.', hold: 1e9, async run() {} }] }
  },
})
