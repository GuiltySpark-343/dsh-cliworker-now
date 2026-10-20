import { cliOf, type TaskMode, type Worker } from './types.ts'

export interface WorkerPermissionState {
  currentValue: TaskMode
  options: Array<{ value: TaskMode; name: string; description: string }>
  writable: boolean
  reason?: string
}

/** Existing adapter modes only; DSH full-access/auto are not invented CLI modes. */
export function workerPermissionOptions(
  worker: Pick<Worker, 'preference' | 'transport'>,
): WorkerPermissionState['options'] {
  const cli = cliOf(worker.preference)
  const canPlan =
    cli !== 'hermes' && cli !== 'harness' && cli !== 'qoder' && cli !== 'qodercn' && (cli !== 'kimi' || worker.transport === 'kimi-acp-v1')
  return [
    ...(canPlan
      ? [
          {
            value: 'plan' as const,
            name: '规划（只读）',
            description: '使用此 CLI 的原生规划或只读模式；DSH 工具桥保持只读。',
          },
        ]
      : []),
    ...(cli !== 'harness'
      ? [
          {
            value: 'accept-edits' as const,
            name: '允许编辑',
            description: '沿用此 CLI 的原生保护，并受所属主会话的权限与审批约束。',
          },
        ]
      : []),
  ]
}
