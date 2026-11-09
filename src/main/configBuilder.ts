import type { ConnectMode, Outbound, Profile, RouteRule, Settings } from '@shared/types'
import { isXray } from '@shared/xray'

// Сборка конфига sing-box 1.14 из настроек и выбранного профиля.

export interface BuildInput {
  settings: Settings
  /** Профили, которые попадут в конфиг (обычно вся группа выбранного профиля). */
  profiles: Profile[]
  /** id выбранного профиля или 'auto' — автовыбор по задержке. */
  selected: string
  mode: ConnectMode
  rulesDir: string
  dataDir: string
  clashSecret: string
  clashPort: number
  /** Локальные SOCKS-порты Xray для профилей с xhttp: id профиля → порт. */
  xrayPorts?: Record<string, number>
}

type Json = Record<string, unknown>

/** «https://1.1.1.1/dns-query», «tls://8.8.8.8», «8.8.8.8», «local» → DNS-сервер sing-box. */
export function dnsServer(spec: string, tag: string, detour?: string): Json {
  const s = spec.trim()
  if (!s || s === 'local' || s === 'system') return { type: 'local', tag }
  const withDetour = (o: Json): Json => (detour ? { ...o, detour } : o)
  const m = s.match(/^(https|h3|tls|quic|tcp|udp):\/\/([^/:]+|\[[^\]]+\])(?::(\d+))?(\/.*)?$/i)
  if (!m) return withDetour({ type: 'udp', tag, server: s })
  const [, scheme, host, port, path] = m
  const o: Json = { type: scheme.toLowerCase(), tag, server: host.replace(/^\[|\]$/g, '') }
  if (port) o.server_port = Number(port)
  if (path && (scheme === 'https' || scheme === 'h3') && path !== '/dns-query') o.path = path
  return withDetour(o)
}

function ruleToSingbox(r: RouteRule, remoteSets: Json[], rulesDir: string): Json | null {
  const values = r.value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
  if (!values.length) return null
  const target = r.action === 'block' ? { action: 'reject' } : { outbound: r.action }
  if (r.match === 'geosite' || r.match === 'geoip') {
    const tags = values.map((v) => {
      const tag = `${r.match}-${v.toLowerCase()}`
      if (LOCAL_SETS.includes(tag)) addSet(remoteSets, localSet(tag, rulesDir))
      else if (!remoteSets.some((s) => s.tag === tag)) {
        const repo = r.match === 'geosite' ? 'sing-geosite' : 'sing-geoip'
        remoteSets.push({
          type: 'remote',
          tag,
          format: 'binary',
          url: `https://raw.githubusercontent.com/SagerNet/${repo}/rule-set/${tag}.srs`,
          download_detour: 'proxy'
        })
      }
      return tag
    })
    return { rule_set: tags, ...target }
  }
  return { [r.match]: values, ...target }
}

/** Профиль → outbound или endpoint sing-box. null — профиль в этот запуск не попадает. */
export function toSingbox(p: Profile, xrayPorts: Record<string, number> = {}): { outbound?: Json; endpoint?: Json } | null {
  const o = p.outbound as Json
  if (isXray(p.outbound)) {
    const port = xrayPorts[p.id]
    if (!port) return null
    return { outbound: { type: 'socks', tag: p.id, server: '127.0.0.1', server_port: port, version: '5' } }
  }
  if (o.type === 'wireguard') {
    return {
      endpoint: clean({
        type: 'wireguard',
        tag: p.id,
        address: o.local_address,
        private_key: o.private_key,
        mtu: o.mtu,
        peers: [
          clean({
            address: o.server,
            port: o.server_port,
            public_key: o.peer_public_key,
            pre_shared_key: o.pre_shared_key,
            allowed_ips: ['0.0.0.0/0', '::/0'],
            reserved: o.reserved,
            persistent_keepalive_interval: 25
          })
        ]
      })
    }
  }
  return { outbound: { ...stripTag(p.outbound), tag: p.id } }
}

function convert(profiles: Profile[], xrayPorts?: Record<string, number>): { ids: string[]; outbounds: Json[]; endpoints: Json[] } {
  const ids: string[] = []
  const outbounds: Json[] = []
  const endpoints: Json[] = []
  for (const p of profiles) {
    const r = toSingbox(p, xrayPorts)
    if (!r) continue
    ids.push(p.id)
    if (r.outbound) outbounds.push(r.outbound)
    if (r.endpoint) endpoints.push(r.endpoint)
  }
  return { ids, outbounds, endpoints }
}

export function buildConfig(i: BuildInput): Json {
  const { settings: s, mode } = i
  const { ids, outbounds, endpoints } = convert(i.profiles, i.xrayPorts)
  if (ids.length > 1) {
    outbounds.push({
      type: 'urltest',
      tag: 'auto',
      outbounds: ids,
      url: s.testUrl,
      interval: '5m',
      tolerance: 80
    })
  }
  const choices = ids.length > 1 ? ['auto', ...ids] : ids
  outbounds.unshift({
    type: 'selector',
    tag: 'proxy',
    outbounds: choices,
    default: choices.includes(i.selected) ? i.selected : choices[0],
    interrupt_exist_connections: true
  })
  outbounds.push({ type: 'direct', tag: 'direct' })

  // DNS
  const dns: Json = {
    servers: [
      dnsServer(s.dnsRemote, 'dns-remote', 'proxy'),
      withResolver(dnsServer(s.dnsDirect, 'dns-direct')),
      { type: 'local', tag: 'dns-bootstrap' }
    ],
    rules: [] as Json[],
    final: s.routeMode === 'direct' ? 'dns-direct' : 'dns-remote',
    strategy: s.ipv6 ? 'prefer_ipv4' : 'ipv4_only',
  }

  // Правила маршрутизации
  const rules: Json[] = [{ action: 'sniff' }]
  // Xray сам ходит к своим серверам; в TUN его трафик (и DNS) не должен вернуться в туннель.
  if (mode === 'tun' && Object.keys(i.xrayPorts ?? {}).length) rules.push({ process_name: ['xray.exe'], outbound: 'direct' })
  if (mode === 'tun') rules.push({ protocol: 'dns', action: 'hijack-dns' })
  rules.push({ ip_is_private: true, outbound: 'direct' })

  const ruleSets: Json[] = []
  const dnsRules = dns.rules as Json[]

  if (s.routeMode === 'rule') {
    for (const r of s.rules.filter((x) => x.enabled)) {
      const sb = ruleToSingbox(r, ruleSets, i.rulesDir)
      if (sb) rules.push(sb)
    }
    if (s.blockAds) {
      addSet(ruleSets, localSet('geosite-category-ads-all', i.rulesDir))
      rules.push({ rule_set: ['geosite-category-ads-all'], action: 'reject' })
    }
    if (s.bypassRu) {
      addSet(ruleSets, localSet('geosite-category-ru', i.rulesDir))
      addSet(ruleSets, localSet('geoip-ru', i.rulesDir))
      const ruDomains = { domain_suffix: ['ru', 'su', 'xn--p1ai', 'xn--d1acj3b', 'by', 'kz'] }
      rules.push({ ...ruDomains, outbound: 'direct' })
      rules.push({ rule_set: ['geosite-category-ru'], outbound: 'direct' })
      rules.push({ rule_set: ['geoip-ru'], outbound: 'direct' })
      dnsRules.push({ ...ruDomains, server: 'dns-direct' })
      dnsRules.push({ rule_set: ['geosite-category-ru'], server: 'dns-direct' })
    }
  }

  const inbounds: Json[] = [
    {
      type: 'mixed',
      tag: 'mixed-in',
      listen: s.allowLan ? '0.0.0.0' : '127.0.0.1',
      listen_port: s.mixedPort,
    }
  ]
  if (mode === 'tun') {
    inbounds.push({
      type: 'tun',
      tag: 'tun-in',
      interface_name: 'Orbita',
      address: s.ipv6 ? ['172.18.0.1/30', 'fdfe:dcba:9877::1/126'] : ['172.18.0.1/30'],
      mtu: s.tunMtu,
      auto_route: true,
      strict_route: s.tunStrictRoute,
      stack: s.tunStack
    })
  }

  return {
    log: { level: s.logLevel, timestamp: false },
    dns,
    inbounds,
    outbounds,
    ...(endpoints.length ? { endpoints } : {}),
    route: {
      rules,
      ...(ruleSets.length ? { rule_set: ruleSets } : {}),
      final: s.routeMode === 'direct' ? 'direct' : 'proxy',
      auto_detect_interface: true,
      default_domain_resolver: 'dns-direct'
    },
    experimental: {
      clash_api: {
        external_controller: `127.0.0.1:${i.clashPort}`,
        secret: i.clashSecret
      },
      cache_file: { enabled: true, path: `${i.dataDir}/cache.db`.replace(/\\/g, '/') }
    }
  }
}

/** Конфиг только для замера задержек: никаких входов, кроме clash api. */
export function buildTestConfig(
  profiles: Profile[],
  port: number,
  secret: string,
  xrayPorts?: Record<string, number>,
  /** Для теста скорости: локальный mixed-вход, весь трафик которого идёт в этот профиль. */
  speed?: { listenPort: number; profileId: string }
): Json {
  const { outbounds, endpoints } = convert(profiles, xrayPorts)
  return {
    log: { level: 'error' },
    dns: { servers: [{ type: 'local', tag: 'local' }] },
    ...(speed ? { inbounds: [{ type: 'mixed', tag: 'speed-in', listen: '127.0.0.1', listen_port: speed.listenPort }] } : {}),
    outbounds: [...outbounds, { type: 'direct', tag: 'direct' }],
    ...(endpoints.length ? { endpoints } : {}),
    route: { final: speed ? speed.profileId : 'direct', default_domain_resolver: 'local' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${port}`, secret } }
  }
}

/** DNS-сервер, заданный доменом, сам должен как-то резолвиться — через системный DNS. */
function withResolver(o: Json): Json {
  const host = String(o.server ?? '')
  if (host && !/^[\d.]+$/.test(host) && !host.includes(':')) return { ...o, domain_resolver: 'dns-bootstrap' }
  return o
}

function addSet(sets: Json[], set: Json): void {
  if (!sets.some((x) => x.tag === set.tag)) sets.push(set)
}

const LOCAL_SETS = ['geosite-category-ru', 'geosite-category-ads-all', 'geoip-ru']

function localSet(tag: string, dir: string): Json {
  return { type: 'local', tag, format: 'binary', path: `${dir}/${tag}.srs`.replace(/\\/g, '/') }
}

function stripTag(o: Outbound): Outbound {
  const { tag: _t, ...rest } = o as Outbound & { tag?: unknown }
  return rest
}

function clean(o: Json): Json {
  const out: Json = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') out[k] = v
  return out
}
