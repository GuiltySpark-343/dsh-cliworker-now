import { ACCOUNT_LOGIN_HOSTS } from '../../shared/account-links.ts'
import { FlowGuide, type FlowDefinition, type FlowStep } from './engine.ts'

const DOWN = '\x1b[B'

/** Both rows must have been drawn before offering either native choice. */
const method = (id: string, second: 'copy' | 'device'): FlowStep => ({
  id,
  when: ['login method:', 'Browser login (default)', second === 'copy' ? 'Copy code login (headless)' : 'Device code login (headless)'],
  guide: () => ({
    step: id,
    tone: 'action',
    template: 'choice',
    text: '选择登录方式。',
    options: [
      { id: 'browser', label: '浏览器登录' },
      second === 'copy' ? { id: 'copy', label: '复制授权码登录' } : { id: 'device', label: '设备码登录' },
    ],
  }),
  respond: (response) => {
    if (!('option' in response)) return undefined
    if (response.option === 'browser') return { keys: '\r', resets: true }
    if (response.option === second) return { keys: DOWN, enter: true, resets: true }
    return undefined
  },
})

/*
 * Pi login windows for a provider picked in the account window, and the sign-out of
 * one login. Pi 1.0.4 screens captured in isolated homes on 2026-10-27;
 * probes/pi-window contains private captures, never credential fixtures in Git.
 */
export const PI_FLOW: FlowDefinition = {
  name: 'Pi',
  targets: true,
  links: ACCOUNT_LOGIN_HOSTS.pi,
  deviceCode: /Enter\s+code:\s*([A-Z0-9]{3,12}(?:-[A-Z0-9]{3,12})?)(?=\s|$)/i,
  login: {
    steps: [
      {
        id: 'authentication',
        when: (screen) =>
          screen.has('Select authentication method for', 'Sign in with an API key') &&
          ['Sign in with an account', 'Sign in with ChatGPT', 'Sign in with Kimi Code', 'Sign in with OpenRouter', 'Sign in with SuperGrok or X Premium'].some((label) => screen.has(label)),
        guide: () => ({
          step: 'authentication',
          tone: 'action',
          template: 'choice',
          text: '选择此服务商的认证方式。',
          options: [{ id: 'account', label: '使用账号登录' }, { id: 'api-key', label: '使用 API Key' }],
        }),
        respond: (response) => {
          if (!('option' in response)) return undefined
          if (response.option === 'account') return { keys: '\r', resets: true }
          if (response.option === 'api-key') return { keys: DOWN, enter: true, resets: true }
          return undefined
        },
      },
      method('copy-method', 'copy'),
      method('device-method', 'device'),
      {
        id: 'github-domain',
        when: ['GitHub Enterprise URL/domain (blank for github.com)'],
        guide: () => ({
          step: 'github-domain',
          tone: 'action',
          template: 'choice',
          text: '使用 github.com 账号登录。企业版域名请在原生终端中填写。',
          options: [{ id: 'github.com', label: 'github.com' }],
        }),
        respond: (response) =>
          'option' in response && response.option === 'github.com' ? { keys: '\r', resets: true } : undefined,
      },
      {
        id: 'browser-code',
        when: (screen) => [
          'Complete login in your browser, or paste the authorization code / redirect URL here:',
          'Complete login in your browser, or paste the final redirect URL here:',
          'Complete sign-in in your browser, or paste the authorization code / redirect URL here:',
          'Paste the code Anthropic shows after you sign in:',
        ].some((marker) => screen.has(marker)),
        guide: (screen) => ({
          step: 'browser-code',
          tone: 'action',
          template: 'browserCode',
          text: '打开登录页面并授权。如果页面显示授权码，或浏览器未自动完成登录，请将授权码或最终重定向地址粘贴到下方。',
          link: screen.link,
        }),
        // Pi keeps running after a browser callback completes the login.
        watches: 'login',
        respond: (response, ctx) =>
          'code' in response ? { keys: FlowGuide.paste(response.code.trim(), ctx), enter: true, confirm: 'login' } : undefined,
        typedConfirms: 'login',
      },
      {
        id: 'device',
        when: (screen) => screen.has('Enter code:') && !!screen.code,
        guide: (screen) => ({
          step: 'device',
          tone: 'action',
          template: 'deviceCode',
          text: '打开验证页面，输入下方设备码并完成授权。只使用你自己发起登录时显示的设备码。',
          link: screen.link,
          code: screen.code,
        }),
        watches: 'login',
      },
      {
        id: 'key',
        when: (screen) => /Enter\s+[^\r\n]{1,100}?\s+API\s+key/i.test(screen.plain) && screen.has('to cancel,', 'to submit'),
        guide: () => ({
          step: 'key',
          tone: 'action',
          template: 'secret',
          text: '粘贴此服务商的 API Key。提交后将由 Pi 保存，请勿分享原生终端中的密钥回显。',
        }),
        respond: (response, ctx) =>
          'secret' in response ? { keys: FlowGuide.paste(response.secret.trim(), ctx), enter: true, confirm: 'login' } : undefined,
        typedConfirms: 'login',
      },
    ],
  },
  logout: { steps: [] },
}
