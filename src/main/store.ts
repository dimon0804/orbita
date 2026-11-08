import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Group, Profile, Settings } from '@shared/types'

export interface DayStat {
  date: string
  up: number
  down: number
}

export interface Data {
  settings: Settings
  groups: Group[]
  profiles: Profile[]
  stats: DayStat[]
  /** Флаг «ядро работало» — если приложение упало с включённым системным прокси, при старте его надо снять. */
  dirty?: boolean
  /** PID запущенного ядра — чтобы добить его, если приложение упало. */
  corePid?: number
  /** Человек отказал в UAC — сами больше не спрашиваем. */
  elevateDeclined?: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  connectMode: 'system',
  routeMode: 'rule',
  mixedPort: 2088,
  allowLan: false,
  clashPort: 9097,
  tunStack: 'mixed',
  tunMtu: 9000,
  tunStrictRoute: false,
  ipv6: false,
  dnsRemote: 'https://1.1.1.1/dns-query',
  dnsDirect: 'https://77.88.8.8/dns-query',
  bypassRu: true,
  blockAds: false,
  rules: [],
  testUrl: 'https://www.gstatic.com/generate_204',
  logLevel: 'info',
  launchOnStartup: false,
  startMinimized: false,
  connectOnLaunch: false,
  closeToTray: true,
  runAsAdmin: true,
  checkUpdates: true,
  hotkey: 'CommandOrControl+Alt+O',
  notifications: true,
  autoReconnect: true,
  theme: 'dark',
  accent: '#7c5cff'
}

export const dataDir = (): string => {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const file = (): string => join(dataDir(), 'orbita.json')

function load(): Data {
  const base: Data = {
    settings: { ...DEFAULT_SETTINGS },
    groups: [{ id: 'default', name: 'Мои серверы', kind: 'manual', order: 0 }],
    profiles: [],
    stats: []
  }
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf-8')) as Partial<Data>
    return {
      ...base,
      ...raw,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      groups: raw.groups?.length ? raw.groups : base.groups
    }
  } catch {
    return base
  }
}

let data: Data | null = null
let timer: NodeJS.Timeout | null = null

export const db = (): Data => (data ??= load())

export function save(now = false): void {
  if (timer) clearTimeout(timer)
  const write = (): void => {
    timer = null
    const tmp = file() + '.tmp'
    writeFileSync(tmp, JSON.stringify(db(), null, 1))
    renameSync(tmp, file())
  }
  if (now) write()
  else timer = setTimeout(write, 400)
}

export const newId = (): string => randomUUID().slice(0, 8)

export function addTraffic(profileId: string | undefined, up: number, down: number): void {
  const d = db()
  const date = new Date().toISOString().slice(0, 10)
  let day = d.stats.find((s) => s.date === date)
  if (!day) {
    day = { date, up: 0, down: 0 }
    d.stats.push(day)
    if (d.stats.length > 90) d.stats.splice(0, d.stats.length - 90)
  }
  day.up += up
  day.down += down
  const p = d.profiles.find((x) => x.id === profileId)
  if (p) {
    p.traffic ??= { up: 0, down: 0 }
    p.traffic.up += up
    p.traffic.down += down
  }
}
