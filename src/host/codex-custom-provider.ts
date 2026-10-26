import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface CodexCustomProviderRoute {
  root: string
  name: string
  baseUrl: string
  bearer: string
}

/**
 * Local patch (cc-switch / declared custom provider): when the user routes Codex
 * through their own `[model_providers.*]` entry, the CLI itself carries the
 * credential, so the Host cannot see a Codex account. This reads that declared
 * route read-only instead of refusing the CLI. Never mutates the user's config.
 *
 * Opt-in: without `~/.dsh/cliworker-now/codex-custom-provider.txt` containing `1`
 * (or CLIWORKER_CODEX_CUSTOM_PROVIDER=1) the stock refusal stays in force.
 */
export function codexCustomProviderOptIn(): boolean {
  if (process.env.CLIWORKER_CODEX_CUSTOM_PROVIDER === '1') return true
  try {
    return (
      readFileSync(join(homedir(), '.dsh', 'cliworker-now', 'codex-custom-provider.txt'), 'utf8').trim() === '1'
    )
  } catch {
    return false
  }
}

export async function codexCustomProviderRoute(
  _project: string,
  _signal?: AbortSignal,
): Promise<CodexCustomProviderRoute | undefined> {
  if (!codexCustomProviderOptIn()) return undefined
  const root = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'))
  let raw: string
  try {
    raw = await readFile(join(root, 'config.toml'), 'utf8')
  } catch {
    return undefined
  }
  let found: CodexCustomProviderRoute | undefined
  let name = ''
  let baseUrl = ''
  let bearer = ''
  const flush = () => {
    if (name && baseUrl) found = { root, name, baseUrl, bearer }
  }
  for (const line of raw.split(/\r?\n/)) {
    const table = /^\s*\[\s*model_providers\s*\.\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(line)
    if (table) {
      flush()
      name = table[1]!.replace(/^["']|["']$/g, '').trim()
      baseUrl = ''
      bearer = ''
      continue
    }
    if (/^\s*\[/.test(line)) {
      flush()
      name = ''
      continue
    }
    if (!name) continue
    const url = /^\s*base_url\s*=\s*["']([^"']+)["']/.exec(line)
    if (url) baseUrl = url[1]!.trim()
    const token = /^\s*experimental_bearer_token\s*=\s*["']([^"']+)["']/.exec(line)
    if (token) bearer = token[1]!.trim()
  }
  flush()
  return found
}
