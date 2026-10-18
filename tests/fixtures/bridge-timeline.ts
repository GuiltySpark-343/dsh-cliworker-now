import { BridgeProtocol } from '../../src/host/bridge-protocol.ts'
import { foldEvents, type WorkerEvent } from '../../src/shared/types.ts'

/** Synthetic native frames through the production bridge and timeline fold. */
export function foldNativeFrames(frames: readonly unknown[]) {
  const events: WorkerEvent[] = []
  const protocol = new BridgeProtocol((event) => events.push({ ...event, seq: events.length + 1, runId: 'synthetic-run', time: '' }), () => {}, 1024 * 1024)
  for (const frame of frames) protocol.feed(JSON.stringify(frame) + '\n')
  protocol.end()
  return foldEvents(events)
}
