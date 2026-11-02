import { z } from 'zod'
import { CLI_IDS, cliOf, type Worker } from '../shared/types.ts'
import type { ContextTelemetryCheckpoint } from '../shared/telemetry.ts'
import type { RunTelemetry } from './telemetry.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const source = z.string().min(1).max(1024)
export const contextTelemetrySchema = z.object({
  policy: z.literal(1), cli: z.enum(CLI_IDS), conversationId: source, model: source,
  observedModel: source.optional(), runId: z.uuid(),
  contextUsed: count.optional(), contextCapacity: count.positive().optional(),
  contextRatio: z.number().finite().min(0).max(1).optional(),
  contextSource: source.optional(), contextCapacitySource: source.optional(), contextEstimated: z.boolean().optional(),
  contextBreakdown: z.object({
    systemTokens: count.optional(), toolTokens: count.optional(), messageTokens: count.optional(),
    estimated: z.boolean().optional(), source: source.optional(),
    categories: z.array(z.object({ name: z.string().min(1).max(80), tokens: count,
      kind: z.enum(['used', 'free', 'buffer', 'deferred']) }).strict()).max(64).optional(),
  }).strict().optional(),
}).strict().refine(value => value.contextUsed !== undefined || value.contextRatio !== undefined,
  { message: 'Context requires an observed count or native ratio' })

const contextKeys = ['contextUsed', 'contextCapacity', 'contextRatio', 'contextSource', 'contextCapacitySource',
  'contextEstimated', 'contextBreakdown'] as const
function matching(worker: Worker): ContextTelemetryCheckpoint | undefined {
  const parsed = contextTelemetrySchema.safeParse(worker.contextTelemetry)
  if (!parsed.success) return
  const c = parsed.data
  return c.cli === cliOf(worker.preference) && c.conversationId === worker.conversationId &&
    c.model === worker.preference.model && (!worker.observedModel || c.observedModel === worker.observedModel)
    ? c : undefined
}

/** An absent sample means pending; an own undefined sample explicitly invalidates the prior window. */
export function withContextTelemetry(worker: Worker, current: RunTelemetry): RunTelemetry {
  if (worker.contextInvalidatedRunId === worker.runId) return withoutContextTelemetry(current)
  if (Object.hasOwn(current, 'contextUsed') || Object.hasOwn(current, 'contextRatio')) return current
  const prior = matching(worker)
  if (!prior || (current.contextCapacity !== undefined && current.contextCapacity !== prior.contextCapacity)) return current
  const context: Partial<RunTelemetry> = {}
  for (const key of contextKeys) if (Object.hasOwn(prior, key)) Object.assign(context, { [key]: prior[key] })
  return { ...context, ...current }
}

export function withoutContextTelemetry(current: RunTelemetry): RunTelemetry {
  const result = { ...current }
  for (const key of contextKeys) Object.assign(result, { [key]: undefined })
  return result
}

/** Capture before run identity changes and at settlement; never infer context from a token bill. */
export function captureContextTelemetry(worker: Worker, current: RunTelemetry): ContextTelemetryCheckpoint | undefined {
  const visible = withContextTelemetry(worker, current)
  const context: Partial<RunTelemetry> = {}
  for (const key of contextKeys) if (Object.hasOwn(visible, key)) Object.assign(context, { [key]: visible[key] })
  const parsed = contextTelemetrySchema.safeParse({ policy: 1, cli: cliOf(worker.preference),
    conversationId: worker.conversationId, model: worker.preference.model,
    ...(worker.observedModel ? { observedModel: worker.observedModel } : {}), runId: worker.runId, ...context })
  return parsed.success ? parsed.data : undefined
}
