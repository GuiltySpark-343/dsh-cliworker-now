/** Keep Windows background queries/tasks from starting AGY's own updater. */
export function agyBackgroundEnvironment(
  cli: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  return cli === 'antigravity' && platform === 'win32'
    ? { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
    : {}
}
