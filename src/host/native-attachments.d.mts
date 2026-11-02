export interface NativeAttachment { kind: 'image' | 'file'; path: string; name: string; bytes: number; mimeType?: string }
export function nativeAttachmentCapability(cli: string): boolean
export function attachmentPrompt(prompt: string, attachments?: readonly NativeAttachment[], filesOnly?: boolean): string
export function readNativeAttachment(item: NativeAttachment, signal?: AbortSignal): Promise<{ mimeType: string; size: number; data?: string }>
export function nativeAttachmentInput(protocol: 'text', prompt: string, attachments?: readonly NativeAttachment[], signal?: AbortSignal): Promise<string>
export function nativeAttachmentInput(protocol: 'pi', prompt: string, attachments?: readonly NativeAttachment[], signal?: AbortSignal): Promise<{ message: string; images?: unknown[] }>
export function nativeAttachmentInput(protocol: 'acp' | 'codex' | 'claude' | 'http', prompt: string, attachments?: readonly NativeAttachment[], signal?: AbortSignal): Promise<Record<string, unknown>[]>
