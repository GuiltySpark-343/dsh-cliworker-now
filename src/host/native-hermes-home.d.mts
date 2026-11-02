/** Clear only per-run gateway authentication after the full process range exits. */
export function cleanupHermesHttpHome(stateDirectory: string): Promise<void>
export function prepareHermesHttpHome(
  config: { env?: Record<string, string | undefined>; stateDirectory: string; project: string },
  provider: string,
  model: string,
  key: string,
  port: number,
): Promise<{ home: string; env: Record<string, string | undefined>; cleanup(): Promise<void> }>
