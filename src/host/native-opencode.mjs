import { runNativeSessionHttp } from './native-session-http.mjs'
export const runNativeOpenCode = (config, io) => runNativeSessionHttp(config, io, 'opencode')

export const forkNativeOpenCode = async (config, io) => {
  const { forkNativeSessionHttp } = await import('./native-session-http.mjs')
  return forkNativeSessionHttp(config, io, 'opencode')
}
