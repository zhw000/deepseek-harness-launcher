import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { NoticeLevel } from '../../../shared/types'
import { store, useStore } from '../store'

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" />
}

export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (next: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch${on ? ' on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="switch-track" />
      <span className="switch-thumb" />
    </button>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T
  options: ReadonlyArray<{ value: T; label: ReactNode }>
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map(option => (
        <button key={option.value} type="button" role="tab" aria-selected={option.value === value}
          className={option.value === value ? 'active' : ''} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Progress({ value }: { value: number | null }) {
  return (
    <div className={`progress${value === null ? ' indeterminate' : ''}`}>
      <span style={value === null ? undefined : { width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}

const LEVEL_ICON: Record<NoticeLevel, ReactNode> = {
  info: <Info size={16} />,
  success: <CircleCheck size={16} />,
  warning: <TriangleAlert size={16} />,
  error: <CircleAlert size={16} />,
}

export function Banner({ level, children, action }: { level: NoticeLevel; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner ${level === 'error' ? 'danger' : level}`}>
      {LEVEL_ICON[level]}
      <div className="grow">{children}</div>
      {action}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

/** A text input that commits on blur or Enter, so settings are not saved on every keystroke. */
export function CommitInput({ value, onCommit, className = 'input', ...rest }: {
  value: string
  onCommit: (value: string) => void
  className?: string
  placeholder?: string
  type?: string
  spellCheck?: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <input {...rest} className={className} value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') setDraft(value)
      }} />
  )
}

export function Modal({ title, onClose, children, footer, width = 520 }: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title">{title}</div>
          <button type="button" className="btn ghost sm icon" onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

/** Renders the pending `store.ask()` confirmation, if any. */
export function ConfirmHost() {
  const request = useStore(current => current.confirm)
  if (request === null) return null
  return (
    <Modal title={request.title} onClose={() => request.resolve(false)} width={440} footer={(
      <>
        <button type="button" className="btn" onClick={() => request.resolve(false)}>取消</button>
        <button type="button" className={`btn ${request.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => request.resolve(true)}>
          {request.confirmText ?? '确定'}
        </button>
      </>
    )}>
      <p className="muted" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{request.message}</p>
    </Modal>
  )
}

export function Toasts() {
  const notices = useStore(current => current.notices)
  return (
    <div className="toasts" aria-live="polite">
      {notices.map(notice => (
        <div key={notice.id} className={`toast ${notice.level}`}>
          {LEVEL_ICON[notice.level]}
          <span className="grow">{notice.message}</span>
          <button type="button" className="btn ghost sm icon" onClick={() => store.dismiss(notice.id)} aria-label="关闭"><X size={14} /></button>
        </div>
      ))}
    </div>
  )
}
