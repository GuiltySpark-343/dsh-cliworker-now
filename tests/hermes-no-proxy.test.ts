import { afterEach, expect, it, vi } from 'vitest'
import { hermesAccountEnvironment, hermesNoProxyEnvironment } from '../src/host/hermes-account-context.ts'

afterEach(() => vi.unstubAllEnvs())

// Observed DSH child environment (2026-10-25): Harness appends `[::1]`, which httpx 0.28.1 rejects.
const published = 'localhost,127.0.0.1,::1,.local,[::1]'

it('hands Hermes the bare IPv6 bypass instead of the bracketed form, in both cases of the name', () => {
  expect(hermesNoProxyEnvironment({ NO_PROXY: published, no_proxy: published })).toEqual({
    NO_PROXY: 'localhost,127.0.0.1,::1,.local',
    no_proxy: 'localhost,127.0.0.1,::1,.local',
  })
})

it('rewrites bracketed, ported and CIDR IPv6 entries but leaves IPv4 and domains alone', () => {
  expect(hermesNoProxyEnvironment({ NO_PROXY: '[2001:db8::1]:8080, 10.0.0.0/8 [127.0.0.1] fd00::/8,example.com' })).toEqual({
    NO_PROXY: '2001:db8::1,10.0.0.0/8,[127.0.0.1],fd00::,example.com',
  })
})

it('leaves clean, wildcard and missing values to the inherited environment', () => {
  expect(hermesNoProxyEnvironment({ NO_PROXY: 'localhost,127.0.0.1,::1,.local' })).toEqual({})
  expect(hermesNoProxyEnvironment({ NO_PROXY: '*,[::1]' })).toEqual({})
  expect(hermesNoProxyEnvironment({})).toEqual({})
})

it('applies to every Hermes launch environment without changing the account home settings', () => {
  vi.stubEnv('NO_PROXY', published)
  vi.stubEnv('no_proxy', '')
  const env = hermesAccountEnvironment('/simulation/hermes')
  expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1,.local')
  expect(env).not.toHaveProperty('no_proxy')
  expect(env).toMatchObject({ HERMES_HOME: '/simulation/hermes', HERMES_SAFE_MODE: '1' })
})
