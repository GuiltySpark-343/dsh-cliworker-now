import { runNativeSessionHttp } from './native-session-http.mjs'
export const runNativeMimo = (config, io) => runNativeSessionHttp(config, io, 'mimo')
