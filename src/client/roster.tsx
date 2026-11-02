import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  CLI_IDS,
  CLI_LABELS,
  effortLabel,
  isRetiredCli,
  workerName,
  type CliId,
  type Effort,
  type ModelChoice,
  type RolePreset,
  type RoleSnapshot,
  type RosterEntry,
  type Worker,
} from '../shared/types.ts'
import { displayModelName, visibleModelChoices } from '../shared/model-presentation.ts'
import { BrandIcon, Glyph } from './icons.tsx'
import { operationMessage } from './operation-error.ts'
import { value, type API } from './workers.ts'

/** One probed directory reply; `missing` means the CLI was never probed in settings. */
type CatalogReply = {
  cli: CliId
  missing?: boolean
  current?: boolean
  catalog?: { models: ModelChoice[] }
  preference?: { model: string; effort: Effort } | null
}
type Draft = {
  id?: string
  title: string
  presetId?: string
  cardName: string
  roleSource: 'preset' | 'custom'
  role: RoleSnapshot
  cli: CliId
  model: string
  effort: Effort
}
/** A template owns many instances; old Workers are matched by numbered name. */
const instancesOf = (entry: RosterEntry, workers: Worker[], archived: Worker[]) =>
  [...workers, ...archived].filter((worker) => {
    if (worker.templateId === entry.id) return true
    if (worker.templateId) return false
    const name = workerName(worker)
    return name.startsWith(entry.title) && /^\d+$/.test(name.slice(entry.title.length))
  })

const usable = (reply: CatalogReply | undefined): ModelChoice[] =>
  reply?.missing ? [] : visibleModelChoices(reply?.catalog?.models ?? []).filter((item) => item.efforts?.length)

/** Fill model/effort from the saved project preference, then the first usable model. */
function applyCatalog(draft: Draft, reply: CatalogReply | undefined): Draft {
  const choices = usable(reply)
  const preferred = reply?.preference
  const target = choices.find((model) => model.id === preferred?.model) ?? choices[0]
  if (!target) return { ...draft, model: '' }
  const effort =
    preferred?.effort && target.efforts?.includes(preferred.effort)
      ? preferred.effort
      : target.efforts?.[0] ?? draft.effort
  return { ...draft, model: target.id, effort }
}

/**
 * Session-scoped templates, shown as the fifth view next to the worker status filters.
 * A template fixes CLI/model/effort/role; dispatching creates a numbered instance.
 */
export function RosterList({
  api,
  sessionId,
  workers,
  archived,
  query,
}: {
  api: API
  sessionId: string
  workers: Worker[]
  archived: Worker[]
  query: string
}) {
  const [entries, setEntries] = useState<RosterEntry[]>([])
  const [presets, setPresets] = useState<RolePreset[]>([])
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [catalogs, setCatalogs] = useState<Record<string, CatalogReply>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)
  const [draft, setDraft] = useState<Draft>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [revision, setRevision] = useState(0)
  const action = useRef<AbortController>()

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const [rosterRaw, presetsRaw, settingsRaw] = await Promise.all([
          api.cliworker.roster(sessionId, controller.signal),
          api.cliworker.rolePresets(sessionId, controller.signal),
          api.cliworker.cliSettings(sessionId, controller.signal),
        ])
        if (controller.signal.aborted) return
        const roster: RosterEntry[] = JSON.parse(value(rosterRaw))
        const roles: RolePreset[] = JSON.parse(value(presetsRaw))
        const settings = JSON.parse(value(settingsRaw)) as { enabled?: Record<string, boolean> }
        const next = settings.enabled ?? {}
        setEntries(roster)
        setPresets(roles)
        setEnabled(next)
        const reachable = CLI_IDS.filter((cli) => next[cli] !== false && !isRetiredCli(cli))
        const replies = await Promise.allSettled(
          reachable.map(async (cli) => [
            cli,
            JSON.parse(value(await api.cliworker.rosterCatalog(sessionId, cli, controller.signal))) as CatalogReply,
          ] as const),
        )
        if (controller.signal.aborted) return
        const table: Record<string, CatalogReply> = {}
        for (const reply of replies)
          if (reply.status === 'fulfilled') table[reply.value[0]] = reply.value[1]
        setCatalogs(table)
      } catch (e) {
        if (!controller.signal.aborted) setError(operationMessage(e))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [api, sessionId, revision])

  useEffect(() => () => action.current?.abort(), [])

  const probed = CLI_IDS.filter(
    (cli) => enabled[cli] !== false && !isRetiredCli(cli) && usable(catalogs[cli]).length > 0,
  )
  const suggestTitle = (base: string) => {
    // The bare card name is the template name; numbering belongs to the instances
    // created from it. Only a real collision (template or live Worker) adds a suffix.
    const used = new Set([
      ...entries.map((entry) => entry.title.toLocaleLowerCase()),
      ...workers.flatMap((worker) =>
        [workerName(worker), ...(worker.nameAliases ?? [])].map((name) => name.toLocaleLowerCase()),
      ),
    ])
    if (!used.has(base.toLocaleLowerCase())) return base
    for (let index = 1; index < 1000; index++)
      if (!used.has(`${base}${index}`.toLocaleLowerCase())) return `${base}${index}`
    return base
  }
  const openCard = (preset: RolePreset) => {
    const cli = probed[0] ?? 'codex'
    const base: Draft = {
      title: suggestTitle(preset.name),
      presetId: preset.id,
      cardName: preset.name,
      roleSource: 'preset',
      role: { presetId: preset.id, name: preset.name, summary: preset.summary, prompt: preset.prompt },
      cli,
      model: '',
      effort: 'high',
    }
    setDraft(applyCatalog(base, catalogs[cli]))
    setPicking(false)
    setNotice('')
    setError('')
  }
  const openEntry = (entry: RosterEntry) => {
    const preset = entry.presetId ? presets.find((item) => item.id === entry.presetId) : undefined
    setDraft({
      id: entry.id,
      title: entry.title,
      presetId: entry.presetId,
      cardName: preset?.name ?? entry.role.name,
      // A deleted card can no longer be followed; the saved snapshot becomes custom.
      roleSource: entry.roleSource === 'preset' && !preset ? 'custom' : entry.roleSource,
      role: entry.role,
      cli: entry.cli,
      model: entry.model,
      effort: entry.effort,
    })
    setConfirmDelete(false)
    setNotice('')
    setError('')
  }
  const chooseCli = (cli: CliId) => {
    if (!draft) return
    setDraft(applyCatalog({ ...draft, cli, model: '', effort: draft.effort }, catalogs[cli]))
  }
  const chooseModel = (id: string) => {
    if (!draft) return
    const model = usable(catalogs[draft.cli]).find((item) => item.id === id)
    const effort = model?.efforts?.includes(draft.effort) ? draft.effort : model?.efforts?.[0] ?? draft.effort
    setDraft({ ...draft, model: id, effort })
  }
  const editPrompt = (prompt: string) => {
    if (!draft) return
    setDraft({ ...draft, roleSource: 'custom', role: { ...draft.role, prompt } })
  }
  const followCard = () => {
    if (!draft) return
    const preset = draft.presetId ? presets.find((item) => item.id === draft.presetId) : undefined
    if (!preset) return
    setDraft({
      ...draft,
      roleSource: 'preset',
      cardName: preset.name,
      role: { presetId: preset.id, name: preset.name, summary: preset.summary, prompt: preset.prompt },
    })
  }
  async function persist(remove = false) {
    if (!draft || action.current) return
    if (!remove && (!draft.title.trim() || !draft.model)) {
      setError('请先选择模型并填写名称。')
      return
    }
    const controller = new AbortController()
    action.current = controller
    setBusy(true)
    setError('')
    try {
      if (remove && draft.id) {
        value(await api.cliworker.deleteRosterEntry(sessionId, draft.id, controller.signal))
        if (!controller.signal.aborted) {
          setDraft(undefined)
          setNotice('已删除该可用智能体，它的对话与记录都还在。')
          setRevision((n) => n + 1)
        }
      } else {
        const body = {
          ...(draft.id ? { id: draft.id } : {}),
          title: draft.title.trim(),
          ...(draft.presetId ? { presetId: draft.presetId } : {}),
          roleSource: draft.roleSource,
          role: draft.role,
          cli: draft.cli,
          model: draft.model,
          effort: draft.effort,
        }
        value(await api.cliworker.saveRosterEntry(sessionId, JSON.stringify(body), controller.signal))
        if (!controller.signal.aborted) {
          setDraft(undefined)
          setNotice('已保存，可在本会话按名称派遣。')
          setRevision((n) => n + 1)
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(operationMessage(e))
    } finally {
      if (!controller.signal.aborted) {
        action.current = undefined
        setBusy(false)
      }
    }
  }

  const models = draft ? usable(catalogs[draft.cli]) : []
  const model = models.find((item) => item.id === draft?.model)
  const term = query.trim().toLocaleLowerCase()
  const visible = entries.filter(
    (entry) =>
      !term ||
      `${entry.title} ${entry.model} ${entry.role.name} ${CLI_LABELS[entry.cli]}`
        .toLocaleLowerCase()
        .includes(term),
  )
  const groups = (CLI_IDS as readonly CliId[])
    .map((cli) => ({ cli, rows: visible.filter((entry) => entry.cli === cli) }))
    .filter((group) => group.rows.length > 0)

  return (
    <>
      <div className="cwn-roster-bar">
        <span className="cwn-roster-summary" role="status">
          {loading ? '正在载入可用智能体…' : `${entries.length} 个可用智能体`}
          {!loading && term ? ` · 匹配 ${visible.length}` : ''}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label="新增可用智能体"
          disabled={loading || !presets.length}
          onClick={() => {
            setPicking(true)
            setNotice('')
            setError('')
          }}
        >
          ＋ 新增
        </Button>
      </div>
      {!loading && !entries.length && (
        <div className="cwn-empty">
          <h3>还没有可用智能体</h3>
          <p>
            {presets.length
              ? '点「＋ 新增」选一张角色卡片，为它钉住 CLI、模型和思考强度。'
              : '先去「智能体设置」建一张角色卡片，再回来创建。'}
          </p>
        </div>
      )}
      {groups.map((group) => (
        <section className="cwn-cli-group" key={group.cli} aria-label={`${CLI_LABELS[group.cli]} 可用智能体`}>
          <div className="cwn-cli-heading">
            <BrandIcon cli={group.cli} />
            <strong>{CLI_LABELS[group.cli]}</strong>
            <span>{group.rows.length} 个</span>
          </div>
          <div className="cwn-cli-rows" data-expanded="true">
            <div className="cwn-cli-rows-inner">
              {group.rows.map((entry) => {
                const created = instancesOf(entry, workers, archived)
                return (
                  <div className="cwn-roster-row" key={entry.id}>
                    <button
                      type="button"
                      className="cwn-roster-open"
                      aria-label={`${entry.title}：已创建 ${created.length} 个`}
                      title={created.length ? created.map(workerName).join(' / ') : undefined}
                      onClick={() => openEntry(entry)}
                    >
                      <span className="cwn-worker-line">
                        <span className="cwn-worker-title">{entry.title}</span>
                        <span className="cwn-worker-status">
                          {created.length ? `已创建 ${created.length} 个` : '未创建'}
                        </span>
                      </span>
                      <span className="cwn-worker-meta">
                        <span className="cwn-worker-model">
                          {displayModelName({ cli: entry.cli, model: entry.model, effort: entry.effort })}
                        </span>
                        <span className="cwn-meta-divider">·</span>
                        <span>{effortLabel(entry.effort)}</span>
                        {entry.roleSource === 'custom' && (
                          <>
                            <span className="cwn-meta-divider">·</span>
                            <span>自定义提示词</span>
                          </>
                        )}
                      </span>
                    </button>
                    <Tooltip label="编辑可用智能体" side="bottom" portal>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="cwn-roster-edit"
                        aria-label={`编辑 ${entry.title}`}
                        onClick={() => openEntry(entry)}
                      >
                        <Glyph name="more" />
                      </Button>
                    </Tooltip>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      ))}
      {!loading && entries.length > 0 && !visible.length && (
        <div className="cwn-empty">
          <h3>没有匹配的可用智能体</h3>
          <p>换个关键词，或清空搜索。</p>
        </div>
      )}
      {(error || notice) && (
        <p className="cwn-roster-feedback" role={error ? 'alert' : 'status'}>
          {error || notice}
        </p>
      )}

      <Modal
        open={picking}
        onClose={() => setPicking(false)}
        title="从角色卡片新增"
        closeLabel="关闭"
        className="cwn-roster-dialog"
        contentClassName="cwn-roster-dialog-content"
      >
        <div className="cwn-roster-cards">
          {presets.map((preset) => (
            <button type="button" className="cwn-roster-card" key={preset.id} onClick={() => openCard(preset)}>
              <strong>{preset.name}</strong>
              <span>{preset.summary}</span>
            </button>
          ))}
        </div>
        <p className="cwn-roster-hint">
          选一张卡片，下一步为它钉住 CLI、模型和思考强度。卡片本身仍然只管提示词。
        </p>
      </Modal>

      <Modal
        open={draft !== undefined}
        onClose={() => {
          if (!busy) {
            setDraft(undefined)
            setConfirmDelete(false)
          }
        }}
        title={draft?.id ? '编辑可用智能体' : '新增可用智能体'}
        closeLabel="关闭"
        className="cwn-roster-dialog"
        contentClassName="cwn-roster-dialog-content"
      >
        {draft && (
          <form
            className="cwn-roster-form"
            onSubmit={(event) => {
              event.preventDefault()
              void persist()
            }}
          >
            <label>
              <span>名称（派遣时按它叫）</span>
              <Input
                className="cwn-control-input"
                aria-label="可用智能体名称"
                value={draft.title}
                maxLength={60}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              />
            </label>
            <div className="cwn-roster-row-fields">
              <label>
                <span>CLI</span>
                <select
                  aria-label="CLI"
                  className="cwn-roster-select"
                  value={draft.cli}
                  disabled={busy}
                  onChange={(event) => chooseCli(event.target.value as CliId)}
                >
                  {CLI_IDS.filter((cli) => enabled[cli] !== false && !isRetiredCli(cli)).map((cli) => (
                    <option key={cli} value={cli} disabled={!usable(catalogs[cli]).length}>
                      {CLI_LABELS[cli]}
                      {usable(catalogs[cli]).length ? '' : '（未探测）'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>模型</span>
                <select
                  aria-label="模型"
                  className="cwn-roster-select"
                  value={draft.model}
                  disabled={busy || !models.length}
                  onChange={(event) => chooseModel(event.target.value)}
                >
                  {!models.length && <option value="">{probed.length ? '请选择 CLI' : '尚无已探测的 CLI'}</option>}
                  {models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>思考强度</span>
                <select
                  aria-label="思考强度"
                  className="cwn-roster-select"
                  value={draft.effort}
                  disabled={busy || !model?.efforts?.length}
                  onChange={(event) => setDraft({ ...draft, effort: event.target.value as Effort })}
                >
                  {(model?.efforts ?? [draft.effort]).map((effort) => (
                    <option key={effort} value={effort}>
                      {effortLabel(effort)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!models.length && (
              <p className="cwn-roster-hint">
                这个 CLI 在当前项目还没有探测记录。先到「设置 → CLI 连接」点一次刷新，再回来选。
              </p>
            )}
            <label>
              <span>
                角色提示词 · 来源卡片「{draft.cardName}」
                {draft.roleSource === 'preset' ? '（跟随卡片）' : '（本条目自定义）'}
              </span>
              <textarea
                aria-label="角色提示词"
                className="cwn-roster-prompt"
                value={draft.role.prompt}
                maxLength={30000}
                disabled={busy}
                onChange={(event) => editPrompt(event.target.value)}
                rows={8}
              />
            </label>
            <div className="cwn-roster-form-actions">
              {draft.roleSource === 'custom' && draft.presetId && (
                <Button type="button" variant="ghost" size="md" disabled={busy} onClick={followCard}>
                  恢复跟随卡片
                </Button>
              )}
              {draft.id && (
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  className="cwn-role-delete"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  删除
                </Button>
              )}
              <span className="cwn-roster-spacer" />
              <Button
                type="button"
                variant="outline"
                size="md"
                disabled={busy}
                onClick={() => {
                  setDraft(undefined)
                  setConfirmDelete(false)
                }}
              >
                取消
              </Button>
              <Button type="submit" variant="primary" size="md" disabled={busy || !draft.model}>
                保存
              </Button>
            </div>
            {confirmDelete && (
              <div className="cwn-role-delete-confirm" role="alert">
                <p>删除「{draft.title}」？它的对话与执行记录会保留，只是不再能按名称派遣。</p>
                <Button type="button" variant="outline" size="md" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  保留
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  className="cwn-role-delete"
                  disabled={busy}
                  onClick={() => void persist(true)}
                >
                  确认删除
                </Button>
              </div>
            )}

            {error && (
              <p className="cwn-roster-feedback" role="alert">
                {error}
              </p>
            )}
          </form>
        )}
      </Modal>
    </>
  )
}
