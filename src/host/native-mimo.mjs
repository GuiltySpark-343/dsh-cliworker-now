import { runNativeSessionHttp } from './native-session-http.mjs'
export const runNativeMimo = (config, io) => runNativeSessionHttp(config, io, 'mimo')

export const forkNativeMimo = async (config, io) => {
  const { forkNativeSessionHttp } = await import('./native-session-http.mjs')
  return forkNativeSessionHttp(config, io, 'mimo')
}
