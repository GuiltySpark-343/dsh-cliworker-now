import { execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativePrivacyDiagnostics } from '../../src/host/native-file-privacy.mjs'

// Only synthetic test-owned paths are passed here. Product readers never Set-Acl.
const script = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$r=[Console]::In.ReadToEnd()|ConvertFrom-Json
$user=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($e in $r.entries){
 $p=[string]$e.path
 $directory=(Get-Item -LiteralPath $p -Force).PSIsContainer
 if($directory){$acl=[Security.AccessControl.DirectorySecurity]::new()}else{$acl=[Security.AccessControl.FileSecurity]::new()}
 $acl.SetAccessRuleProtection($true,$false)
 $acl.SetOwner($user)
 $inherit=if($directory){[Security.AccessControl.InheritanceFlags]3}else{[Security.AccessControl.InheritanceFlags]0}
 foreach($sid in @($user.Value,'S-1-5-18','S-1-5-32-544')){
  $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
 }
 if($e.public){
  $rights=if($e.write){[Security.AccessControl.FileSystemRights]::Modify}else{[Security.AccessControl.FileSystemRights]::ReadAndExecute}
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),$rights,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
 }
 Set-Acl -LiteralPath $p -AclObject $acl
}
`
export function syntheticNativeAcl(entries: Array<{ path: string; public?: boolean; write?: boolean }>) {
  if (process.platform !== 'win32') return
  execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { input: JSON.stringify({ entries }), windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] })
}
export function exposeSyntheticNativePath(path: string) {
  if (process.platform === 'win32') syntheticNativeAcl([{ path, public: true }])
  else chmodSync(path, lstatSync(path).isDirectory() ? 0o755 : 0o644)
}

const recordedBatches = new Map<string, Map<string, ReturnType<typeof nativePrivacyDiagnostics>[number]>>()
export function recordSyntheticNativePrivacy(label: string) {
  const prefix = process.env.CWN_NATIVE_PRIVACY_REPORT
  if (process.platform !== 'win32' || !prefix || !/^[a-z-]+$/.test(label)) return
  const all = recordedBatches.get(label) ?? new Map()
  recordedBatches.set(label, all)
  for (const batch of nativePrivacyDiagnostics()) all.set(`${batch.operation}:${batch.phase}`, batch)
  const batches = [...all.values()]
  const readers = [...new Set(batches.map(batch => batch.reader))].map(reader => {
    const own = batches.filter(batch => batch.reader === reader)
    return { reader, calls: own.length, operations: new Set(own.map(batch => batch.operation)).size,
      failures: own.filter(batch => !batch.ok).length, totalMs: own.reduce((sum, batch) => sum + batch.durationMs, 0),
      maxMs: Math.max(...own.map(batch => batch.durationMs)) }
  })
  writeFileSync(`${prefix}-${label}.json`, JSON.stringify({ synthetic: true, platform: process.platform,
    readers, batches }, null, 2) + '\n', { mode: 0o600 })
}
