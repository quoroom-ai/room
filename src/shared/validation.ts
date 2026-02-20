import { z } from 'zod'
import { validateWatchPath } from './watch-path'

const taskStatusValues = ['active', 'paused', 'completed'] as const
const triggerTypeValues = ['cron', 'once', 'manual'] as const

export const idSchema = z.number().int().positive()

export const createWorkerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().trim().min(1).max(50000),
  description: z.string().trim().max(1000).optional(),
  model: z.string().trim().max(200).optional(),
  isDefault: z.boolean().optional()
}).strict()

export const updateWorkerSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().trim().min(1).max(50000).optional(),
  description: z.string().trim().max(1000).optional(),
  model: z.string().trim().max(200).optional(),
  isDefault: z.boolean().optional()
}).strict()

const maybeIsoDatetime = z.string().trim().min(1).refine((value) => !Number.isNaN(new Date(value).getTime()), {
  message: 'Must be a valid ISO-8601 datetime string'
})

export const createTaskSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  prompt: z.string().trim().min(1).max(50000),
  cronExpression: z.string().trim().max(100).optional(),
  triggerType: z.enum(triggerTypeValues).optional(),
  triggerConfig: z.string().trim().max(2000).optional(),
  scheduledAt: maybeIsoDatetime.optional(),
  executor: z.string().trim().max(100).optional(),
  maxRuns: z.number().int().positive().optional(),
  workerId: idSchema.optional(),
  sessionContinuity: z.boolean().optional(),
  timeoutMinutes: z.number().int().positive().max(1440).optional(),
}).strict()

export const updateTaskSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  prompt: z.string().trim().min(1).max(50000).optional(),
  cronExpression: z.string().trim().max(100).optional(),
  triggerType: z.enum(triggerTypeValues).optional(),
  triggerConfig: z.string().trim().max(2000).optional(),
  scheduledAt: maybeIsoDatetime.optional(),
  executor: z.string().trim().max(100).optional(),
  status: z.enum(taskStatusValues).optional(),
  lastRun: z.string().trim().max(100).optional(),
  lastResult: z.string().max(50000).optional(),
  errorCount: z.number().int().min(0).optional(),
  maxRuns: z.number().int().positive().nullable().optional(),
  runCount: z.number().int().min(0).optional(),
  memoryEntityId: idSchema.nullable().optional(),
  workerId: idSchema.nullable().optional(),
  sessionContinuity: z.boolean().optional(),
  sessionId: z.string().trim().max(200).nullable().optional(),
  timeoutMinutes: z.number().int().positive().max(1440).nullable().optional(),
}).strict()

export const watchPathSchema = z.string().trim().min(1).superRefine((path, ctx) => {
  const err = validateWatchPath(path)
  if (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: err })
  }
})

export const createWatchSchema = z.object({
  path: watchPathSchema,
  description: z.string().trim().max(500).optional(),
  actionPrompt: z.string().trim().max(50000).optional()
}).strict()

export const settingsKeySchema = z.string().trim().min(1).max(200)
export const settingsValueSchema = z.string().max(10000)
