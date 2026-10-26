import type { AccountAction, AccountLoginMode } from '../../shared/accounts.ts'
import type { CliId } from '../../shared/types.ts'
import { AgyAccountGuide } from '../agy-account-guide.ts'
import { FlowGuide, type AccountGuideDriver, type FlowDefinition } from './engine.ts'
import { CLAUDE_FLOW, CODEX_FLOW, GROK_FLOW, MIMO_FLOW, QODERCN_FLOW, QODER_FLOW, ZCODE_FLOW } from './single-account.ts'

/** CLIs whose login/logout window the plugin draws; every other CLI keeps its native terminal. */
const FLOWS: Partial<Record<CliId, FlowDefinition>> = {
  codex: CODEX_FLOW,
  claude: CLAUDE_FLOW,
  qoder: QODER_FLOW,
  qodercn: QODERCN_FLOW,
  grok: GROK_FLOW,
  zcode: ZCODE_FLOW,
  mimo: MIMO_FLOW,
}

export function accountFlow(cli: CliId): FlowDefinition | undefined {
  return FLOWS[cli]
}

export function createAccountGuide(
  cli: CliId,
  action: AccountAction,
  options: { provider?: string; mode?: AccountLoginMode } = {},
): AccountGuideDriver | undefined {
  if (action === 'manage') return undefined
  if (cli === 'antigravity') return new AgyAccountGuide(action)
  const flow = FLOWS[cli]
  if (!flow || (action === 'login' ? !flow.login : !flow.logout)) return undefined
  return new FlowGuide(flow, { action, ...options })
}
