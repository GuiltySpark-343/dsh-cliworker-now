import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ModelProviderGroup,
  ModelCatalogFailure,
  ModelSelection,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  cliOf,
  CLI_LABELS,
  effortLabel,
  type Worker,
  type ModelChoice,
  type Preference,
} from '../shared/types.ts'
import { visibleModelChoices } from '../shared/model-presentation.ts'
import { value, type API } from './workers.ts'

/** Exact rc.2 ModelSelect business data contract, populated only from CLI metadata. */
export interface NativeCliModelDirectoryState {
  current: ModelSelection | null
  retainedEffort?: string
  routable: boolean | null
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  pending: ModelSelection | null
  error: string | null
}

export class NativeCliModelDirectory {
  readonly store = createSnapshotStore<NativeCliModelDirectoryState>({
    current: null,
    routable: null,
    groups: [],
    failures: [],
    status: 'idle',
    pending: null,
    error: null,
  })
  private request?: AbortController
  private generation = 0
  private selectionObservation = 0
  private closed = false
  private models: ModelChoice[] = []
  private worker: Worker
  private locked = true
  constructor(
    private readonly api: API,
    private readonly parentId: string,
    worker: Worker,
  ) {
    this.worker = worker
    this.sync(worker, true)
  }
  sync(worker: Worker, locked: boolean) {
    if (this.closed || worker.id !== this.worker.id || worker.parentSessionId !== this.parentId) return
    if (JSON.stringify(worker.preference) !== JSON.stringify(this.worker.preference)) this.selectionObservation++
    this.worker = worker
    this.locked = locked
    const state = this.store.getSnapshot()
    const current = this.selection(worker.preference)
    if (JSON.stringify(state.current) !== JSON.stringify(current))
      this.store.set({ ...state, current, retainedEffort: effortLabel(worker.preference.effort) })
  }
  private selection(preference: Preference): ModelSelection {
    const model = this.models.find(
      (item) => item.id === preference.model || Object.values(item.variants ?? {}).includes(preference.model),
    )
    return {
      provider: `cliworker:${cliOf(preference)}`,
      model: model?.id ?? preference.model,
      reasoningEffort: preference.effort,
    }
  }
  load = () => {
    if (this.closed || this.store.getSnapshot().status === 'selecting') return
    this.request?.abort()
    const request = (this.request = new AbortController()),
      generation = ++this.generation
    this.store.set({ ...this.store.getSnapshot(), status: 'loading', error: null })
    void this.api.cliworker
      .catalogForWorker(this.parentId, this.worker.id, request.signal)
      .then((result) => {
        if (this.closed || request.signal.aborted || generation !== this.generation) return
        const catalog = JSON.parse(value(result)) as { cli: string; models: ModelChoice[]; notice?: string }
        if (
          catalog.cli !== cliOf(this.worker.preference) ||
          !Array.isArray(catalog.models) ||
          !catalog.models.length
        )
          throw new Error(catalog.notice || '当前 CLI 未返回可用的模型目录')
        this.models = catalog.models
        const current = this.selection(this.worker.preference)
        const groups: ModelProviderGroup[] = [
          {
            id: current.provider,
            name: CLI_LABELS[cliOf(this.worker.preference)],
            models: visibleModelChoices(catalog.models, this.worker.preference.model).map((model) => ({
              id: model.id,
              name: model.label,
              reasoning: {
                efforts: (model.efforts ?? []).map((effort) => ({ id: effort, name: effortLabel(effort) })),
                defaultEffort: model.efforts?.includes(this.worker.preference.effort)
                  ? this.worker.preference.effort
                  : model.efforts?.[0],
              },
            })),
          },
        ]
        this.store.set({
          current,
          groups,
          retainedEffort: effortLabel(this.worker.preference.effort),
          routable: groups[0]!.models.some((model) => model.id === current.model),
          failures: [],
          status: 'ready',
          pending: null,
          error: null,
        })
      })
      .catch((error) => {
        if (this.closed || request.signal.aborted || generation !== this.generation) return
        this.store.set({ ...this.store.getSnapshot(), status: 'error', error: String(error), pending: null })
      })
  }
  select = async (selection: ModelSelection): Promise<RemoteResult<void>> => {
    const fail = (message: string): RemoteResult<void> => ({
      ok: false,
      error: Object.assign(new Error(message), { code: 'gateway/bad-request' as const, details: {}, isDSHRemoteError: true as const }),
    })
    if (this.closed || this.locked) return fail('请等待本轮结束，并发送或移除待发消息后再修改模型')
    if (this.store.getSnapshot().status === 'selecting') return fail('正在保存模型设置，请等待完成')
    const cli = cliOf(this.worker.preference)
    const model = this.models.find((item) => item.id === selection.model)
    const effort = selection.reasoningEffort ?? model?.efforts?.[0]
    if (
      selection.provider !== `cliworker:${cli}` ||
      !model ||
      !effort ||
      !model.efforts?.includes(effort as Preference['effort'])
    )
      return fail('只能选择当前 CLI 真实目录中的模型和思考强度')
    const generation = ++this.generation
    const observation = this.selectionObservation
    this.request?.abort()
    const request = this.request = new AbortController()
    this.store.set({ ...this.store.getSnapshot(), status: 'selecting', pending: selection, error: null })
    try {
      const saved = JSON.parse(
        value(
          await this.api.cliworker.configureWorker(
            this.parentId,
            this.worker.id,
            JSON.stringify({ cli, model: model.id, effort }),
          request.signal,
          ),
        ),
      ) as Worker
      if (this.closed || generation !== this.generation) return fail('会话已切换，请重新核对模型设置')
      if (
        saved.id !== this.worker.id ||
        saved.parentSessionId !== this.parentId ||
        cliOf(saved.preference) !== cli
      )
        throw new Error('收到不匹配的 Worker 设置')
      // A later watch value can win while this older save's receipt is in
      // flight (another native occurrence or command may have saved it).
      if (observation === this.selectionObservation) this.worker = saved
      this.store.set({
        ...this.store.getSnapshot(),
        current: this.selection(this.worker.preference),
        retainedEffort: effortLabel(this.worker.preference.effort),
        status: 'ready',
        pending: null,
        error: null,
      })
      return { ok: true, value: undefined }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.closed && generation === this.generation)
        this.store.set({ ...this.store.getSnapshot(), status: 'error', pending: null, error: message })
      return fail(message)
    }
  }
  dispose() {
    this.closed = true
    this.generation++
    this.request?.abort()
  }
}
