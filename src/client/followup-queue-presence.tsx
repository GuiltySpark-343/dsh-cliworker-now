import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { QueuedFollowup } from '../shared/types.ts'

const exitDuration = 220
// Allow the browser one frame to finish the CSS transition before removing its DOM.
const removalDelay = exitDuration + 32
interface PresentItem {
  item: QueuedFollowup
  index: number
  exiting: boolean
}
export interface FollowupQueuePresenceProps {
  scopeKey: string
  items: QueuedFollowup[]
  expanded: boolean
  bodyId: string
  heading: (count: number) => ReactNode
  renderItem: (item: QueuedFollowup, index: number) => ReactNode
}

/** Scope changes must never carry a previous conversation's fading messages. */
export function FollowupQueuePresence(props: FollowupQueuePresenceProps) {
  return <QueuePresence key={props.scopeKey} {...props} />
}

function QueuePresence({ items, expanded, bodyId, heading, renderItem }: FollowupQueuePresenceProps) {
  const [rows, setRows] = useState<PresentItem[]>(() =>
    items.map((item, index) => ({ item, index, exiting: false })),
  )
  const current = useRef(rows)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  )

  useLayoutEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const changed = () => setReducedMotion(query.matches)
    changed()
    query.addEventListener('change', changed)
    return () => query.removeEventListener('change', changed)
  }, [])
  useLayoutEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer)
      timers.current.clear()
    },
    [],
  )

  useLayoutEffect(() => {
    const liveIds = new Set(items.map((item) => item.id))
    for (const [id, timer] of timers.current) {
      if (liveIds.has(id) || reducedMotion) {
        clearTimeout(timer)
        timers.current.delete(id)
      }
    }
    const previous = current.current
    const next: PresentItem[] = items.map((item, index) => ({ item, index, exiting: false }))
    if (!reducedMotion) {
      for (let index = 0; index < previous.length; index++) {
        const old = previous[index]!
        if (liveIds.has(old.item.id)) continue
        // Keep removed rows before their surviving successor, so unrelated rows
        // shrink into place instead of being reordered during the fade.
        const successor = previous.slice(index + 1).find((row) => liveIds.has(row.item.id))
        const position = successor ? next.findIndex((row) => row.item.id === successor.item.id) : -1
        next.splice(position < 0 ? next.length : position, 0, { ...old, exiting: true })
        if (!timers.current.has(old.item.id)) {
          const timer = setTimeout(() => {
            if (timers.current.get(old.item.id) !== timer) return
            timers.current.delete(old.item.id)
            current.current = current.current.filter((row) => row.item.id !== old.item.id || !row.exiting)
            setRows(current.current)
          }, removalDelay)
          timers.current.set(old.item.id, timer)
        }
      }
    }
    current.current = next
    setRows(next)
  }, [items, reducedMotion])

  if (!rows.length) return null
  const exiting = items.length === 0
  return (
    <div className="cwn-followup-shell" data-exiting={exiting}>
      <div className="cwn-followup-shell-inner">
        <section
          className="cwn-followup-queue"
          aria-label="待发送消息"
          aria-live="polite"
          aria-hidden={exiting || undefined}
          {...(exiting ? { inert: '' } : {})}
        >
          <div className="cwn-followup-heading">{heading(items.length || rows.length)}</div>
          <div
            id={bodyId}
            className="cwn-followup-body"
            data-expanded={expanded}
            aria-hidden={!expanded}
            {...(!expanded ? { inert: '' } : {})}
          >
            <div className="cwn-followup-body-inner">
              <ol>
                {rows.map(({ item, index, exiting: rowExiting }) => (
                  <li
                    key={item.id}
                    className="cwn-followup-row"
                    data-queue-id={item.id}
                    data-exiting={rowExiting}
                    aria-hidden={rowExiting || undefined}
                    {...(rowExiting ? { inert: '' } : {})}
                  >
                    <div className="cwn-followup-row-inner">
                      <div className="cwn-followup-row-content">{renderItem(item, index)}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
