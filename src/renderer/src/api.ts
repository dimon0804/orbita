import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CoreStatus, Group, LogLine, Profile, Settings } from '@shared/types'

declare global {
  interface Window {
    orbita: {
      call: <T = unknown>(ch: string, ...args: unknown[]) => Promise<T>
      on: (ch: string, fn: (p: unknown) => void) => () => void
    }
  }
}

export const call = <T = unknown>(ch: string, ...args: unknown[]): Promise<T> => window.orbita.call<T>(ch, ...args)
export const on = (ch: string, fn: (p: unknown) => void): (() => void) => window.orbita.on(ch, fn)

export interface DayStat {
  date: string
  up: number
  down: number
}

export interface AppState {
  settings: Settings
  groups: Group[]
  profiles: Profile[]
  stats: DayStat[]
  status: CoreStatus
  isAdmin: boolean
  version: string
}

// ───── простое хранилище на подписках ─────

function createStore<T>(initial: T) {
  let value = initial
  const subs = new Set<() => void>()
  return {
    get: () => value,
    set: (v: T) => {
      value = v
      subs.forEach((s) => s())
    },
    sub: (fn: () => void) => {
      subs.add(fn)
      return () => subs.delete(fn)
    }
  }
}

export const appState = createStore<AppState | null>(null)

export interface SpeedPoint {
  t: number
  up: number
  down: number
}
const HISTORY = 90
export const speed = createStore<SpeedPoint[]>(
  Array.from({ length: HISTORY }, (_, i) => ({ t: Date.now() - (HISTORY - i) * 1000, up: 0, down: 0 }))
)
export const session = createStore({ up: 0, down: 0 })

export const logs = createStore<LogLine[]>([])

export interface Toast {
  id: number
  kind: 'ok' | 'error' | 'warn' | 'info'
  text: string
}
export const toasts = createStore<Toast[]>([])
let toastId = 0
export function toast(kind: Toast['kind'], text: string): void {
  const t = { id: ++toastId, kind, text }
  toasts.set([...toasts.get(), t].slice(-4))
  setTimeout(() => toasts.set(toasts.get().filter((x) => x.id !== t.id)), kind === 'error' ? 7000 : 3500)
}

/** Вызов с тостом об ошибке. */
export async function act<T>(p: Promise<T>, ok?: string | ((r: T) => string)): Promise<T | undefined> {
  try {
    const r = await p
    if (ok) toast('ok', typeof ok === 'function' ? ok(r) : ok)
    return r
  } catch (e) {
    toast('error', e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': /, '') : String(e))
    return undefined
  }
}

let started = false
export function startBridge(): void {
  if (started) return
  started = true
  void call<AppState>('state').then(appState.set)
  void call<LogLine[]>('logs').then(logs.set)
  on('state', (s) => {
    const prev = appState.get()
    const next = s as AppState
    if (prev?.status.state !== 'running' && next.status.state === 'running') session.set({ up: 0, down: 0 })
    appState.set(next)
  })
  on('traffic', (p) => {
    const t = p as { up: number; down: number }
    const arr = speed.get().slice(1)
    arr.push({ t: Date.now(), up: t.up, down: t.down })
    speed.set(arr)
    const s = session.get()
    session.set({ up: s.up + t.up, down: s.down + t.down })
  })
  on('log', (l) => {
    const arr = logs.get()
    const next = arr.length > 3000 ? arr.slice(-2500) : arr.slice()
    next.push(l as LogLine)
    logs.set(next)
  })
  on('toast', (t) => {
    const x = t as { kind: Toast['kind']; text: string }
    toast(x.kind, x.text)
  })
  on('latency', (p) => {
    const { id, delay } = p as { id: string; delay: number | null }
    const st = appState.get()
    if (!st) return
    appState.set({
      ...st,
      profiles: st.profiles.map((x) => (x.id === id ? { ...x, latency: delay, latencyAt: Date.now() } : x))
    })
  })
  // Пока ядро стоит — двигаем график нулями, чтобы он не замирал.
  setInterval(() => {
    if (appState.get()?.status.state === 'running') return
    const arr = speed.get().slice(1)
    arr.push({ t: Date.now(), up: 0, down: 0 })
    speed.set(arr)
  }, 1000)
}

export function useStore<T>(s: { get: () => T; sub: (fn: () => void) => () => void }): T {
  return useSyncExternalStore(s.sub, s.get)
}

export function useNow(ms = 1000): number {
  const [n, setN] = useState(Date.now())
  useEffect(() => {
    const i = setInterval(() => setN(Date.now()), ms)
    return () => clearInterval(i)
  }, [ms])
  return n
}

// ───── форматирование ─────

export function bytes(n: number, digits = 1): string {
  if (!n) return '0 Б'
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${u[i]}`
}

export const rate = (n: number): string => bytes(n) + '/с'

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (x: number): string => String(x).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}

export const PROTO_LABEL: Record<string, string> = {
  vless: 'VLESS',
  vmess: 'VMess',
  trojan: 'Trojan',
  shadowsocks: 'SS',
  hysteria2: 'Hy2',
  hysteria: 'Hy',
  tuic: 'TUIC',
  socks: 'SOCKS',
  http: 'HTTP',
  anytls: 'AnyTLS',
  wireguard: 'WG',
  naive: 'Naive',
  ssh: 'SSH'
}

export function protoLabel(o: { type: string; tls?: unknown; version?: unknown }): string {
  const tls = (o.tls as { enabled?: boolean; reality?: { enabled?: boolean } } | undefined) ?? undefined
  if (o.type === 'http' && tls?.enabled) return 'HTTPS'
  if (o.type === 'socks') return `SOCKS${o.version ?? '5'}`
  if (o.type === 'vless' && tls?.reality?.enabled) return 'Reality'
  return PROTO_LABEL[o.type] ?? o.type.toUpperCase()
}

export function latencyClass(l: number | null | undefined): string {
  if (l === undefined) return 'lat-none'
  if (l === null) return 'lat-bad'
  if (l < 250) return 'lat-good'
  if (l < 600) return 'lat-mid'
  return 'lat-slow'
}

export function flag(cc?: string): string {
  if (!cc || cc.length !== 2) return '🌐'
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)))
}

/** Флаг из названия сервера: «🇩🇪 Germany» или «DE-1». */
export function nameFlag(name: string): string | null {
  const m = name.match(/[\u{1F1E6}-\u{1F1FF}]{2}/u)
  return m ? m[0] : null
}

export function stripFlag(name: string): string {
  const f = nameFlag(name)
  return f ? name.replace(f, '').trim() : name
}
