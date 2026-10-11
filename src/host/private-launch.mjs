// Set a private file-creation mask without mutating the shared Harness process.
import { spawn } from 'node:child_process'
import { nativeLaunchArgv } from './native-launch.mjs'
process.umask(0o077)
const [executable, ...argv] = nativeLaunchArgv(process.argv.slice(2))
// Background metadata/tasks inherit their streams, never a new Windows console.
const child = spawn(executable, argv, { env: process.env, stdio: 'inherit', windowsHide: true })
let stopped = false
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stopped = true
    child.kill(signal)
  })
child.on('error', () => {
  process.stderr.write('CLI launch failed\n')
  process.exitCode = 1
})
child.on('close', (code, signal) => {
  process.exitCode = stopped || signal ? 143 : (code ?? 1)
})
