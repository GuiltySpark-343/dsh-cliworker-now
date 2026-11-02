import type { NativeHarnessConnection } from './native-harness-tools.ts'
export const AGY_HARNESS_SESSION_FILE: string
export function agyHarnessServerName(connection: NativeHarnessConnection): string
export function prepareAgyHarnessWorkspace(input: {
  directory: string; argv: string[]; connection: NativeHarnessConnection;
  nodeExecutable?: string; mcpEntryPath?: string; platform?: string;
}): { argv: string[]; env: Record<string, string> }
export function recordAgyHarnessSession(config: { stopDirectory: string }, id: string, env?: Record<string, string | undefined>): void
export function agyHarnessHookDecision(payload: unknown, options?: { env?: Record<string, string | undefined>; signal?: AbortSignal }): Promise<{ decision: string; reason?: string }>
