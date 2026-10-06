import { hero } from './hero'
import { parts } from './parts'
import { partitions } from './partitions'
import { mergeTree } from './mergeTree'
import { sparseIndex } from './sparseIndex'
import { queryParallelism } from './queryParallelism'
import { distributed } from './distributed'
import { materializedView } from './materializedView'
import { refreshableViews } from './refreshableViews'
import { projections } from './projections'
import { skipIndexes } from './skipIndexes'
import { prewhere } from './prewhere'
import { lazyMaterialization } from './lazyMaterialization'
import { dictionaries } from './dictionaries'
import { orderBy } from './orderBy'
import { dataTypes } from './dataTypes'
import { insertStrategy } from './insertStrategy'
import { mutations } from './mutations'
import type { SceneDef } from './types'

/** Lessons grouped the way clickhouse.com/docs/concepts groups them. */
export const SECTIONS: { title: string; scenes: SceneDef[] }[] = [
  { title: 'Start here', scenes: [hero] },
  { title: 'Fundamentals', scenes: [parts, partitions, mergeTree, sparseIndex, queryParallelism, distributed] },
  { title: 'Features', scenes: [materializedView, refreshableViews, projections, skipIndexes, prewhere, lazyMaterialization, dictionaries] },
  { title: 'Best practices', scenes: [orderBy, dataTypes, insertStrategy, mutations] },
]

export const LESSONS: SceneDef[] = SECTIONS.flatMap((s) => s.scenes)

/** Older lesson URLs keep working. */
const ALIASES: Record<string, string> = { mergetree: 'merges', 'sparse-index': 'primary-indexes', orderby: 'primary-key' }

export const findScene = (id: string) => LESSONS.find((s) => s.id === (ALIASES[id] ?? id))
