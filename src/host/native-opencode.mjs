import { runNativeSessionHttp } from './native-session-http.mjs'
export const runNativeOpenCode = (config, io) => runNativeSessionHttp(config, io, 'opencode')
