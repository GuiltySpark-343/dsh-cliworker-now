import type { HarnessConversationBinding, HarnessConversationFeature } from '../shared/types.ts'

const reasons: Partial<Record<HarnessConversationFeature, string>> = {
  goal: '当前 CLI 不支持目标',
  plan: '当前 CLI 不支持规划模式',
  feedback: '当前 CLI 不支持反馈',
  fork: '当前 CLI 不支持会话分支',
  forkEarlier: '当前 CLI 只支持从最新一轮分支',
}

export function harnessFeatureReason(
  binding: HarnessConversationBinding,
  feature: HarnessConversationFeature,
) {
  return binding.capabilities[feature]
    ? undefined
    : binding.reasons?.[feature] || reasons[feature] || '当前 CLI 不支持此功能'
}

/** Without plan mode, accept-edits is the only permission mode, so there is nothing to switch. */
export function harnessPermissionReason(binding: HarnessConversationBinding) {
  return binding.capabilities.plan ? undefined : '当前 CLI 只有“允许编辑”一种权限模式'
}
