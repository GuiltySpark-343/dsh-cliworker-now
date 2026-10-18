import { WorkerRuntime as NativeWorkerRuntime } from '../../src/host/runtime.ts'
import type { CliId } from '../../src/shared/types.ts'

/** Existing wire fixtures exercise the retained pre-migration session path explicitly.
 * Native transport defaults and bridge execution are covered by native-runtime.test.ts.
 */
export class WorkerRuntime extends NativeWorkerRuntime {
  protected override initialTransport(cli: CliId): string | undefined {
    // Qoder was introduced with ACP and has no pre-migration execution path.
    return cli === 'qoder' ? super.initialTransport(cli) : undefined
  }
}
