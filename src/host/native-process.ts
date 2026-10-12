import { nativeLaunchArgv, resolveNativeEntry } from './native-launch.mjs'
import { win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProcessBackend } from './process.ts'
import { isCurrentWindowsRuntime, needsWindowsHiddenLaunch, spawnWindowsHidden } from './windows-hidden-process.ts'
import { windowsCodexBackgroundLaunch } from './windows-codex-launch.ts'
const privateLauncher = fileURLToPath(new URL('./private-launch.mjs', import.meta.url))

/** One normalization boundary for tasks, metadata and interactive account menus. */
export function nativeProcessBackend(
  backend: ProcessBackend,
  platform = process.platform,
  options: { electron?: boolean } = {},
): ProcessBackend {
  const normalize = <T extends { argv: readonly string[]; env?: NodeJS.ProcessEnv }>(spec: T, background = false) => {
    const requested = nativeLaunchArgv(spec.argv, platform)
    // A known npm launcher can itself spawn a console executable with inherited
    // handles. Preserve its installation/env semantics before adding Node mode
    // for our own GUI helpers; that mode does not belong to the native target.
    const launch = background && platform === 'win32'
      ? windowsCodexBackgroundLaunch(requested, spec.env, { platform })
      : undefined
    const argv = launch?.argv ?? requested
    const env = launch?.env ?? spec.env
    return {
      ...spec,
      argv,
      ...(launch ? { env } : {}),
      ...(argv[0] === process.execPath || (platform === 'win32' && isCurrentWindowsRuntime(argv[0]!))
        ? { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
    }
  }
  return {
    async resolveExecutable(name) {
      return resolveNativeEntry(await backend.resolveExecutable(resolveNativeEntry(name, platform)), platform)
    },
    spawn(spec) {
      const normalized = normalize(spec, true)
      const electron = options.electron ?? !!process.versions.electron
      // Fold only our exact private-umask helper into the background relay.
      // Leaving another pipe relay beneath it would delay the native exit
      // receipt until all descendants released their inherited output pipes.
      if (platform === 'win32' && electron && isCurrentWindowsRuntime(normalized.argv[0]!) &&
          normalized.argv.length > 2 && win32.normalize(normalized.argv[1]!).toLowerCase() === win32.normalize(privateLauncher).toLowerCase())
        return spawnWindowsHidden(backend, { ...normalized, argv: nativeLaunchArgv(normalized.argv.slice(2), platform) }, { privateUmask: true })
      return needsWindowsHiddenLaunch(normalized.argv, platform, electron)
        ? spawnWindowsHidden(backend, normalized)
        : backend.spawn(normalized)
    },
    ...(backend.spawnTerminal
      ? {
          spawnTerminal: (spec: Parameters<NonNullable<ProcessBackend['spawnTerminal']>>[0]) =>
            backend.spawnTerminal!(normalize(spec)),
        }
      : {}),
  }
}
