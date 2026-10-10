// Windows account PTY bootstrap. No native CLI runs until its process has been
// assigned to the separate lifecycle Job owner; no task sandbox is applied.
import { spawn } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeLaunchArgv } from './native-launch.mjs'
process.umask(0o077)
const [directory, encoded] = process.argv.slice(2)
let requested
try { requested = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) } catch { process.exit(1) }
if (!directory || !Array.isArray(requested) || !requested.length || requested.some(value => typeof value !== 'string')) process.exit(1)
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
    const child = spawn(executable, argv, { env: process.env, stdio: 'inherit' })
    child.once('error', () => { process.stderr.write('CLI launch failed\r\n') })
    child.once('close', recordExit)
  } catch {
    process.stderr.write('CLI launch failed\r\n')
    recordExit(1)
  }
}
