export function nativeControlPathKey(path: string, platform?: string): string
export function createPiOmpControl(
  directory: string,
  options?: { timeoutMs?: number },
): Promise<{
  nonce: string
  steer: (message: string, requestId: string, signal?: AbortSignal) => Promise<void>
  close: () => Promise<void>
}>
export function receivePiOmpControl(
  directory: string,
  nonce: string,
  handle: (message: string, requestId: string, attempt: string) => Promise<void>,
): Promise<{ close: () => Promise<void> }>
