import type { NativeHarnessConnection } from './native-harness-tools.ts'
export function nativeHarnessExecutionReady(cli: string): boolean
export function nativeHarnessAcpApproval(config: { cli: string; harnessTools?: NativeHarnessConnection }, params: unknown, signal?: AbortSignal): Promise<string | undefined>
export interface HarnessToolCapability { transport: boolean; ready: boolean; reason?: string }
export const HARNESS_MCP_SERVER: string
export function nativeHarnessToolCapability(cli: string, connection?: NativeHarnessConnection): HarnessToolCapability
export function buildNativeHarnessInjection(input: {
  cli: string
  argv: string[]
  env?: Record<string, string>
  connection?: NativeHarnessConnection
  nodeExecutable?: string
  mcpEntryPath?: string
}): HarnessToolCapability & { argv: string[]; env: Record<string, string>; acpMcpServers?: Array<Record<string, unknown>> }
export function nativeHarnessMcpServers(config: { cli: string; argv: string[]; harnessTools?: NativeHarnessConnection }, env?: Record<string, string | undefined>): Array<Record<string, unknown>>
