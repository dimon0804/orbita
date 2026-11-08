export function Logo({ size = 20, on = false }: { size?: number; on?: boolean }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={on ? 'logo logo-on' : 'logo'} aria-hidden>
      <circle cx="16" cy="16" r="6" fill="currentColor" />
      <ellipse cx="16" cy="16" rx="14" ry="6" fill="none" stroke="currentColor" strokeWidth="2.2"
        transform="rotate(-28 16 16)" opacity=".85" />
    </svg>
  )
}
