// Pi 1.0.2 / 1.0.4 native UI compatibility entry. No initial prompt, injected keystrokes,
// model request, or subscription validation: open its own provider login menu.
// `login <provider>` opens that provider's own login (Pi's /login <provider>);
// `logout <auth> <provider>` removes that stored credential with Pi's own API, no UI.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectPiInstallation } from './pi-installation.mjs'

process.umask(0o077)
try {
  const executable = process.argv[2]
  const action = process.argv[3] ?? 'login'
  if (!['login', 'logout'].includes(action)) throw new Error('Invalid account action')
  if (!executable) throw new Error('Missing Pi entry')
  const provider = process.argv[action === 'logout' ? 5 : 4]
  if (provider !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) throw new Error('Invalid provider')
  const { dist } = inspectPiInstallation(executable)
  const {
    createAgentSessionServices,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    SessionManager,
    InteractiveMode,
    ModelRuntime,
  } = await import(pathToFileURL(join(dist, 'index.js')).href)
  if (
    [
      createAgentSessionServices,
      createAgentSessionFromServices,
      createAgentSessionRuntime,
      SessionManager?.inMemory,
      InteractiveMode,
    ].some((entry) => typeof entry !== 'function') ||
    ['init', action === 'logout' ? 'showOAuthSelector' : 'handleLoginCommand', 'run'].some(
      (method) => typeof InteractiveMode.prototype[method] !== 'function',
    )
  )
    throw new Error('Unsupported Pi login SDK capabilities')
  const cwd = process.cwd(),
    agentDir = process.env.PI_CODING_AGENT_DIR
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        ...(action === 'logout'
          ? {
              modelRuntime: await ModelRuntime.create({
                authPath: process.argv[4],
                modelsPath: null,
                modelsStorePath: join(agentDir, 'models-store.json'),
                refreshOnCreate: false,
                allowModelNetwork: false,
              }),
            }
          : {}),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      })
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        noTools: 'all',
        tools: [],
      })
      return { ...created, services, diagnostics: services.diagnostics }
    },
    { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) },
  )
  const ui = new InteractiveMode(runtime)
  if (action === 'logout' && provider) {
    // The same call as Pi's /logout selector, for the one provider chosen in the plugin window.
    await runtime.session.modelRuntime.logout(provider, { signal: AbortSignal.timeout(15_000) })
    process.stdout.write('已移除该服务商的凭据。\n')
    process.exit(0)
  }
  await ui.init()
  if (action === 'logout') await ui.showOAuthSelector('logout')
  else await ui.handleLoginCommand(provider)
  await ui.run()
} catch {
  // Native errors can contain authentication data. Keep this boundary generic.
  process.stderr.write('无法打开 Pi 原生账号界面，请检查 Pi Coding Agent 安装与受支持的原生接口。\n')
  process.exitCode = 1
}
