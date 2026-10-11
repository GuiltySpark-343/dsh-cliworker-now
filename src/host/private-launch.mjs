// Set a private file-creation mask without mutating the shared Harness process.
import { forwardNativeStdio, spawnNativeProcess } from './native-spawn.mjs'
import { nativeLaunchArgv } from './native-launch.mjs'
process.umask(0o077)
const [executable, ...argv] = nativeLaunchArgv(process.argv.slice(2))
// This helper is also used under POSIX PTYs, whose original handles must stay.
// Windows ConPTY account launch unwraps it in windows-account-launch.mjs.
const backgroundPipes = process.platform === 'win32'
const child = spawnNativeProcess(executable, argv, { env: process.env, stdio: backgroundPipes ? ['pipe', 'pipe', 'pipe'] : 'inherit' })
if (backgroundPipes) forwardNativeStdio(child)
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
