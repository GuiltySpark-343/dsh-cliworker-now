// Windows account PTY bootstrap. No native CLI runs until its process has been
// assigned to the separate lifecycle Job owner; no task sandbox is applied.
import { accountInput } from './windows-account-stdio.mjs'
import { fileURLToPath } from 'node:url'
import { spawnNativeProcess } from './native-spawn.mjs'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeLaunchArgv } from './native-launch.mjs'
process.umask(0o077)
const [directory, encoded] = process.argv.slice(2)
let requested
try { requested = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) } catch { process.exit(1) }
if (!directory || !Array.isArray(requested) || !requested.length || requested.some(value => typeof value !== 'string')) process.exit(1)
// This exact plugin wrapper only sets umask and delegates an argv array. This
// helper already does both; avoid another GUI runtime losing console stdin.
if (requested[0] === process.execPath && requested[1] === fileURLToPath(new URL('./private-launch.mjs', import.meta.url)))
  requested = requested.slice(2)
const until = Date.now() + 15_000
while (!existsSync(join(directory, 'ready'))) {
  if (Date.now() >= until) process.exit(1)
  await delay(20)
}
// Keep ConPTY alive after the native command exits so Host can dispose its
// native worker before closing the entire Job. Only the exit code is exposed.
setInterval(() => {}, 1000)
const recordExit = (code, signal) => {
  const exitCode = Number.isInteger(code) ? code : 1
  writeFileSync(join(directory, 'exit'), JSON.stringify({ exitCode, signal: signal ?? null }), { mode: 0o600 })
}
if (!existsSync(join(directory, 'cancel')) && !existsSync(join(directory, 'stop'))) {
  try {
    const [executable, ...argv] = nativeLaunchArgv(requested)
    // Node-based CLI account UIs also need their own Electron stdin restored.
    // This fixed preload is scoped to that child, never NODE_OPTIONS or Host.
    if (executable === process.execPath && process.versions.electron)
      argv.unshift('--import', new URL('./windows-account-stdio.mjs', import.meta.url).href)
    // Keep the existing ConPTY handles; a GUI-subsystem parent must not cause
    // the native CLI to present an additional Windows console window.
    const child = spawnNativeProcess(executable, argv, { env: process.env, stdio: [accountInput, 1, 2] })
    child.once('error', () => { process.stderr.write('CLI launch failed\r\n') })
    child.once('close', recordExit)
  } catch {
    process.stderr.write('CLI launch failed\r\n')
    recordExit(1)
  }
}
