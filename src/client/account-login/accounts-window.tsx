import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountLogin, AccountProvider, AccountSource, AccountStatus } from '../../shared/accounts.ts'
import { GUIDED_ACCOUNT_CLIS, parseAccountLoginId } from '../../shared/account-links.ts'
import { CLI_LABELS, type CliId } from '../../shared/types.ts'
import { AccountTerminal, type AccountCloseControl } from '../account-terminal.tsx'
import { t, useT } from '../i18n.ts'
import { NativeChoice } from '../native-settings-choice.tsx'
import { hostText } from '../operation-error.ts'
import type { API } from '../workers.ts'

/** The account window's own choice for a native picker. */
const NATIVE = '__native__'

type Request = {
  action: 'login' | 'logout'
  provider?: string
  login?: string
  replaces?: string
  source?: AccountSource
  title: string
}

const order = (source?: AccountSource) => (source === 'native' ? 0 : source === 'plugin' ? 1 : 2)

const loginText = (login: AccountLogin) =>
  login.authMethod === 'api'
    ? t('{provider} API 登录', { provider: login.providerLabel })
    : t('{provider}账号登录', { provider: login.providerLabel })

/**
 * The 「账号」 window of a CLI that keeps several logins (2026-10-26 decision):
 * every login with its own 退出, and 添加账号 with a 「登录到」 provider picker.
 */
export function AccountsWindow({
  api,
  sessionId,
  cli,
  status,
  closeControl,
  onRefresh,
  onClose,
}: {
  api: API
  sessionId: string
  cli: CliId
  status?: AccountStatus
  closeControl: AccountCloseControl
  onRefresh: () => void
  onClose: () => void
}) {
  useT()
  const name = CLI_LABELS[cli]
  // Kimi reports API providers as configured, not verified; their rows are still signed out one by one.
  const logins = status?.state === 'authenticated' || status?.state === 'configured' ? (status.logins ?? []) : []
  // A signed-in CLI that reports no separate logins still has one row to sign out.
  const whole = !logins.length && status?.state === 'authenticated'
  const rows: AccountLogin[] = whole
    ? [{ providerLabel: '', authMethod: status.authMethod ?? 'oauth', accountLabel: status.accountLabel }]
    : logins
  const providers = status?.actions.find((item) => item.id === 'login')?.providers
  const sources = status?.actions.find((item) => item.id === 'logout')?.sources ?? []
  const [request, setRequest] = useState<Request>()
  const [adding, setAdding] = useState(false)
  const [confirming, setConfirming] = useState<number>()
  const closingAll = useRef(false)
  const terminalClose: AccountCloseControl = useRef<(() => Promise<boolean>) | undefined>(undefined)
  // The dialog's close button ends a running window first, then the whole dialog.
  useEffect(() => {
    const request = async () => {
      if (!terminalClose.current) {
        onClose()
        return true
      }
      closingAll.current = true
      return terminalClose.current()
    }
    closeControl.current = request
    return () => {
      if (closeControl.current === request) closeControl.current = undefined
    }
  })
  const back = () => {
    if (closingAll.current) return onClose()
    setRequest(undefined)
    setAdding(false)
    setConfirming(undefined)
    onRefresh()
  }

  if (request)
    return (
      <div className="cwn-accounts-run">
        <div className="cwn-accounts-run-head">
          <span>{request.title}</span>
        </div>
        <AccountTerminal
          api={api}
          sessionId={sessionId}
          cli={cli}
          action={request.action}
          source={request.source}
          provider={request.provider}
          login={request.login}
          replaces={request.replaces}
          closeControl={terminalClose}
          onClose={back}
          onFinished={onRefresh}
        />
      </div>
    )

  if (adding)
    return (
      <AddAccount
        cli={cli}
        providers={providers}
        logins={logins}
        onCancel={() => setAdding(false)}
        onStart={(next) => setRequest(next)}
      />
    )

  const signOut = (login: AccountLogin) => {
    if (login.id)
      return setRequest({ action: 'logout', login: login.id, title: t('退出 {account}', { account: loginText(login) }) })
    if (GUIDED_ACCOUNT_CLIS.has(cli)) return setRequest({ action: 'logout', title: t('退出 {cli}', { cli: name }) })
    // No single-login removal for this row: the CLI's own menu, in the row's own location.
    const source = login.source ?? (sources.length === 1 ? sources[0]!.id : undefined)
    setRequest({
      action: 'logout',
      ...(source ? { source } : {}),
      title: t('在原生终端中退出 {cli}', { cli: name }),
    })
  }
  // A key from an environment variable or a config file is not a stored login: nothing to sign out here.
  const configOnly = (login: AccountLogin) =>
    !login.id && !login.source && !whole && (cli === 'pi' || cli === 'omp')
  const row = ({ login, index }: { login: AccountLogin; index: number }) => {
    const removable = !!login.id || GUIDED_ACCOUNT_CLIS.has(cli)
    return (
      <li key={login.id ?? `${login.source ?? ''}-${login.providerLabel}-${index}`} className="cwn-accounts-row" data-confirming={confirming === index}>
        <div className="cwn-accounts-row-main">
          <div className="cwn-accounts-row-text">
            <strong>{whole ? t('当前账号') : loginText(login)}</strong>
            {login.authMethod === 'oauth' && login.accountLabel && <span>{login.accountLabel}</span>}
            {configOnly(login) && <span>{t('来自环境变量或配置文件，请在原配置中管理')}</span>}
          </div>
          {confirming !== index &&
            !configOnly(login) &&
            (removable ? (
              <Button variant="ghost" size="md" onClick={() => setConfirming(index)}>
                {t('退出')}
              </Button>
            ) : (
              !native && (
                <Button variant="ghost" size="md" onClick={() => signOut(login)}>
                  {t('在原生终端中退出')}
                </Button>
              )
            ))}
        </div>
        {confirming === index && (
          <div className="cwn-accounts-confirm" role="group" aria-label={t('确认退出')}>
            <span>
              {cli === 'zcode' && !login.id
                ? t('BigModel 和 Z.AI 的登录会一起退出。')
                : t('退出后会删除这条凭据，其他账号保留。')}
            </span>
            <div className="cwn-login-actions">
              <Button variant="primary" size="md" onClick={() => signOut(login)}>
                {t('确认退出')}
              </Button>
              <Button variant="ghost" size="md" onClick={() => setConfirming(undefined)}>
                {t('取消')}
              </Button>
            </div>
          </div>
        )}
      </li>
    )
  }
  // Older Hosts give no location per row: one native button per location instead.
  const native = !GUIDED_ACCOUNT_CLIS.has(cli) && sources.length > 1 && !rows.some((login) => login.source)
  const sourceLabel = (id: AccountSource) =>
    hostText(sources.find((item) => item.id === id)?.label ?? (id === 'native' ? 'CLI 全局账号' : '插件账号'))
  // Logins kept in several locations are listed under each one.
  const groups: { source?: AccountSource; rows: { login: AccountLogin; index: number }[] }[] = []
  rows.forEach((login, index) => {
    const group = groups.find((item) => item.source === login.source)
    if (group) group.rows.push({ login, index })
    else groups.push({ source: login.source, rows: [{ login, index }] })
  })
  groups.sort((a, b) => order(a.source) - order(b.source))
  const grouped = groups.some((group) => group.source)

  return (
    <div className="cwn-accounts-window">
      {rows.length ? (
        grouped ? (
          groups.map((group) => (
            <section key={group.source ?? 'other'} className="cwn-accounts-group">
              <h4 className="cwn-accounts-group-title">{group.source ? sourceLabel(group.source) : t('其他配置')}</h4>
              <ul className="cwn-accounts-list" aria-label={group.source ? sourceLabel(group.source) : t('其他配置')}>
                {group.rows.map(row)}
              </ul>
            </section>
          ))
        ) : (
          <ul className="cwn-accounts-list" aria-label={t('{cli} 已登录账号', { cli: name })}>
            {groups.flatMap((group) => group.rows).map(row)}
          </ul>
        )
      ) : (
        <p className="cwn-accounts-empty">{t('尚未登录 {cli} 的任何账号。', { cli: name })}</p>
      )}
      {native && rows.length > 0 && (
        <div className="cwn-accounts-native">
          <span className="cwn-login-hint">{t('{cli} 只能在原生菜单中逐个退出，选择账号所在的位置：', { cli: name })}</span>
          <div className="cwn-login-actions">
            {sources.map((source) => (
              <Button
                key={source.id}
                variant="outline"
                size="md"
                onClick={() =>
                  setRequest({
                    action: 'logout',
                    source: source.id,
                    title: t('在原生终端中退出 {cli}', { cli: name }),
                  })
                }
              >
                {hostText(source.label)}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div className="cwn-accounts-foot">
        <Button
          variant="outline"
          size="md"
          onClick={() =>
            providers?.length
              ? setAdding(true)
              : setRequest({ action: 'login', title: t('在原生终端中添加 {cli} 账号', { cli: name }) })
          }
        >
          {t('添加账号')}
        </Button>
        {!providers?.length && <span className="cwn-login-hint">{t('在原生终端中选择服务商并登录。')}</span>}
      </div>
    </div>
  )
}

function AddAccount({
  cli,
  providers,
  logins,
  onCancel,
  onStart,
}: {
  cli: CliId
  providers: AccountProvider[] | undefined
  logins: AccountLogin[]
  onCancel: () => void
  onStart: (request: Request) => void
}) {
  const name = CLI_LABELS[cli]
  const list = providers ?? []
  const [chosen, setChosen] = useState(list[0]?.id ?? NATIVE)
  const [replace, setReplace] = useState<string>()
  const provider = list.find((item) => item.id === chosen)
  // Hermes keeps several keys of one provider: add another, or replace one of them.
  const held = provider?.multi
    ? logins.filter((login) => login.id && parseAccountLoginId(login.id)?.provider === provider.id)
    : []
  useEffect(() => setReplace(undefined), [chosen])
  const choices = [
    ...list.map((item) => ({ id: item.id, label: item.signedIn ? t('{provider}（已登录）', { provider: item.label }) : item.label })),
    // ZCode has only its two providers; other CLIs keep their own full picker.
    ...(cli === 'zcode' ? [] : [{ id: NATIVE, label: t('其他服务商（在原生终端中选择）') }]),
  ]
  const start = () => {
    if (!provider) return onStart({ action: 'login', title: t('在原生终端中添加 {cli} 账号', { cli: name }) })
    onStart({
      action: 'login',
      provider: provider.id,
      ...(replace ? { replaces: replace } : {}),
      title: t('登录到 {provider}', { provider: provider.label }),
    })
  }
  return (
    <div className="cwn-accounts-window">
      <label className="cwn-accounts-field">
        <span>{t('登录到')}</span>
        <NativeChoice label={t('登录到')} selected={chosen} choices={choices} disabled={false} onChange={setChosen} />
      </label>
      {provider?.signedIn && !provider.multi && (
        <p className="cwn-login-callout" data-tone="warning">
          <span>{t('{provider} 已登录，继续会替换它现有的凭据。', { provider: provider.label })}</span>
        </p>
      )}
      {held.length > 0 && (
        <div className="cwn-accounts-mode" role="radiogroup" aria-label={t('{provider} 已有凭据', { provider: provider!.label })}>
          <label>
            <input type="radio" name="cwn-account-mode" checked={!replace} onChange={() => setReplace(undefined)} />
            {t('添加另一个凭据')}
          </label>
          {held.map((login, index) => (
            <label key={login.id}>
              <input type="radio" name="cwn-account-mode" checked={replace === login.id} onChange={() => setReplace(login.id)} />
              {held.length === 1
                ? t('替换现有凭据')
                : t('替换第 {index} 个凭据', { index: String(index + 1) })}
            </label>
          ))}
          {replace && <span className="cwn-login-hint">{t('新凭据确认可用后，才会移除原凭据。')}</span>}
        </div>
      )}
      {!provider && <p className="cwn-login-hint">{t('在原生终端中选择服务商并登录。')}</p>}
      <div className="cwn-login-actions">
        <Button variant="primary" size="md" onClick={start}>
          {t('继续')}
        </Button>
        <Button variant="ghost" size="md" onClick={onCancel}>
          {t('返回')}
        </Button>
      </div>
    </div>
  )
}
