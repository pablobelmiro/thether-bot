import type { EffortLevel } from '@shared/api'

export const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku', 'fable', 'default'] as const
export type ModelOption = (typeof MODEL_OPTIONS)[number]

export const EFFORT_OPTIONS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Maps a display name like "Opus 4.5" or an id like "claude-sonnet-4-5" to a /model alias. */
export function modelAlias(model: string | undefined): ModelOption | undefined {
  if (!model) return undefined
  const m = model.toLowerCase()
  for (const opt of MODEL_OPTIONS) {
    if (opt !== 'default' && m.includes(opt)) return opt
  }
  return undefined
}

export function modelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined
  return model
}
