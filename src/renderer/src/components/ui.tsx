import { ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'

export function Segmented<T extends string>({
  value, options, onChange, disabled
}: {
  value: T
  options: { value: T; label: string; icon?: ReactNode; hint?: string; disabled?: boolean }[]
  onChange: (v: T) => void
  disabled?: boolean
}): React.JSX.Element {
  const idx = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <div className="seg" style={{ ['--n' as string]: options.length, ['--i' as string]: idx }}>
      <span className="seg-thumb" />
      {options.map((o) => (
        <button
          key={o.value}
          className={o.value === value ? 'on' : ''}
          title={o.hint}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function Row({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }): React.JSX.Element {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-title">{title}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <div className="row-ctl">{children}</div>
    </div>
  )
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }): React.JSX.Element {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function NumberInput({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min?: number; max?: number }): React.JSX.Element {
  return (
    <input
      className="input input-num"
      type="number"
      defaultValue={value}
      min={min}
      max={max}
      onBlur={(e) => {
        const v = Number(e.target.value)
        if (Number.isFinite(v) && v !== value && (min === undefined || v >= min) && (max === undefined || v <= max)) onChange(v)
        else e.target.value = String(value)
      }}
    />
  )
}

export function TextInput({ value, onChange, placeholder, wide }: { value: string; onChange: (v: string) => void; placeholder?: string; wide?: boolean }): React.JSX.Element {
  return (
    <input
      className={`input ${wide ? 'input-wide' : ''}`}
      defaultValue={value}
      placeholder={placeholder}
      onBlur={(e) => e.target.value !== value && onChange(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

export function Empty({ icon, title, text, children }: { icon: ReactNode; title: string; text?: string; children?: ReactNode }): React.JSX.Element {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {text && <div className="empty-text">{text}</div>}
      {children && <div className="empty-actions">{children}</div>}
    </div>
  )
}
