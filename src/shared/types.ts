// Общие типы для main и renderer.

/** Исходящее соединение в формате sing-box (без поля tag — его ставит сборщик конфига). */
export type Outbound = { type: string; [key: string]: unknown }

export interface ParsedProfile {
  name: string
  outbound: Outbound
}

export interface Profile extends ParsedProfile {
  id: string
  groupId: string
  /** Исходная ссылка, если профиль пришёл из ссылки или подписки. */
  link?: string
  createdAt: number
  /** Последний замер задержки, мс. null — не отвечает, undefined — не мерили. */
  latency?: number | null
  latencyAt?: number
  traffic?: { up: number; down: number }
}

export interface SubscriptionInfo {
  upload: number
  download: number
  total: number
  expire: number
}

export interface Group {
  id: string
  name: string
  kind: 'manual' | 'subscription'
  url?: string
  userAgent?: string
  updatedAt?: number
  info?: SubscriptionInfo
  /** Автообновление подписки, часы. 0 — выключено. */
  autoUpdateHours?: number
  order: number
}

/** Как трафик попадает в ядро. */
export type ConnectMode = 'proxy' | 'system' | 'tun'
/** Что ядро делает с трафиком. */
export type RouteMode = 'rule' | 'global' | 'direct'

export interface RouteRule {
  id: string
  enabled: boolean
  /** domain_suffix, domain_keyword, ip_cidr, process_name, geosite, geoip */
  match: 'domain_suffix' | 'domain_keyword' | 'ip_cidr' | 'process_name' | 'geosite' | 'geoip'
  value: string
  action: 'proxy' | 'direct' | 'block'
}

export interface Settings {
  connectMode: ConnectMode
  routeMode: RouteMode
  mixedPort: number
  allowLan: boolean
  clashPort: number
  tunStack: 'mixed' | 'system' | 'gvisor'
  tunMtu: number
  tunStrictRoute: boolean
  ipv6: boolean
  dnsRemote: string
  dnsDirect: string
  /** В режиме «по правилам» российские сайты и IP идут напрямую. */
  bypassRu: boolean
  blockAds: boolean
  rules: RouteRule[]
  testUrl: string
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  launchOnStartup: boolean
  startMinimized: boolean
  connectOnLaunch: boolean
  closeToTray: boolean
  /** Держать права администратора (для TUN) без повторных окон UAC. */
  runAsAdmin: boolean
  theme: 'dark' | 'light' | 'system'
  accent: string
  selectedProfileId?: string
}

export interface CoreStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  profileId?: string
  mode?: ConnectMode
  startedAt?: number
  error?: string
}

export interface LogLine {
  t: number
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  text: string
}
