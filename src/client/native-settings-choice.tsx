import { useEffect, useId, useRef, useState } from 'react'
import { Button, Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

export function NativeChoice({
  label,
  selected,
  choices,
  disabled,
  onChange,
  placeholder,
  describedBy,
}: {
  label: string
  selected: string
  choices: { id: string; label: string; disabled?: boolean }[]
  disabled: boolean
  onChange: (value: string) => void
  placeholder?: string
  describedBy?: string
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const [anchorWidth, setAnchorWidth] = useState<number>()
  const menuClass = `cwn-settings-choice-menu-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useEffect(() => {
    const button = anchor.current
    if (!open || !button) return
    const measure = () => {
      const width = button.getBoundingClientRect().width
      if (width > 0) setAnchorWidth(width)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(button)
    return () => observer.disconnect()
  }, [open])
  return (
    <>
      <style>
        {anchorWidth === undefined ? '' : `.${menuClass}{--cwn-settings-choice-width:${anchorWidth}px}`}
      </style>
      <Menu
        open={open && !disabled}
        onClose={() => setOpen(false)}
        portal
        align="start"
        className="cwn-settings-choice"
        listClassName={`cwn-settings-choice-menu ${menuClass}`}
        selectedId={selected}
        items={choices}
        onSelect={(id) => {
          if (!choices.some((choice) => choice.id === id && !choice.disabled)) return
          onChange(id)
          setOpen(false)
        }}
        anchor={
          <Button
            ref={anchor}
            type="button"
            variant="outline"
            size="md"
            aria-label={label}
            aria-describedby={describedBy}
            aria-haspopup="menu"
            aria-expanded={open && !disabled}
            disabled={disabled}
            onClick={() => {
              if (!open) {
                const width = anchor.current?.getBoundingClientRect().width
                if (width && width > 0) setAnchorWidth(width)
              }
              setOpen((old) => !old)
            }}
          >
            <span>
              {choices.find((choice) => choice.id === selected)?.label ??
                placeholder ??
                (label === '默认思考强度' ? '选择强度' : '选择模型')}
            </span>
            <IconChevronDownOutlineRegular size={14} />
          </Button>
        }
      />
    </>
  )
}
