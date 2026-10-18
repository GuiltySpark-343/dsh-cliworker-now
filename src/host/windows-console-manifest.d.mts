export interface ElectronConsoleManifestRequest { nonce: string; packageRoot: string; archivePath: string }
export interface ElectronConsoleManifestProof extends ElectronConsoleManifestRequest { name: 'node-pty'; version: '1.2.0-beta.15' }
export function attestElectronConsoleManifest(request: unknown, runtime?: {
  electron?: string; execPath?: string;
  physical?: { lstat(path: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean }> };
  readManifest?: (path: string) => Promise<Uint8Array | string>;
}): Promise<ElectronConsoleManifestProof>;
