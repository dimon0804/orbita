// Импорт групп и профилей из папки config NekoBox (nekoray).
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Outbound } from '../shared/types'
import { makeXray, XRAY_TRANSPORTS } from '../shared/xray'

type Dict = Record<string, any>

export interface NekoImport {
  groups: { nekoId: number; name: string; url?: string }[]
  profiles: { nekoGroupId: number; name: string; outbound: Outbound }[]
  /** Сколько профилей пропущено (неподдерживаемый тип/транспорт или битый файл). */
  skipped: number
}

function readJson(file: string): Dict | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
  } catch {
    return null
  }
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'))
}

/** Убирает пустые значения, чтобы не засорять outbound. */
function clean<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clean) as T
  if (v && typeof v === 'object') {
    const out: Dict = {}
    for (const [k, val] of Object.entries(v as Dict)) {
      const c = clean(val)
      if (c === undefined || c === null || c === '') continue
      if (Array.isArray(c) && c.length === 0) continue
      if (typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue
      out[k] = c
    }
    return out as T
  }
  return v
}

function list(v: unknown): string[] | undefined {
  if (typeof v !== 'string' || !v) return undefined
  return v.split(',').map((x) => x.trim()).filter(Boolean)
}

function tlsFrom(s: Dict, force = false): Dict | undefined {
  const sec = String(s.sec ?? '')
  if (!force && sec !== 'tls' && sec !== 'reality') return undefined
  const reality = !!s.pbk
  const fp = s.utls || (reality ? 'chrome' : undefined) // reality без uTLS ядро не принимает
  return clean({
    enabled: true,
    server_name: s.sni,
    insecure: s.insecure || undefined,
    alpn: list(s.alpn),
    utls: fp ? { enabled: true, fingerprint: fp } : undefined,
    reality: reality ? { enabled: true, public_key: s.pbk, short_id: s.sid } : undefined
  })
}

/** undefined — без транспорта, null — не поддерживается ядром (xhttp и т.п.). */
function transportFrom(s: Dict): Dict | undefined | null {
  const net = String(s.net || 'tcp')
  switch (net) {
    case 'tcp':
      return undefined
    case 'ws':
      return clean({
        type: 'ws',
        path: s.path || '/',
        headers: s.host ? { Host: s.host } : undefined,
        max_early_data: s.ed_len || undefined,
        early_data_header_name: s.ed_len ? s.ed_name || 'Sec-WebSocket-Protocol' : undefined
      })
    case 'grpc':
      return clean({ type: 'grpc', service_name: s.path })
    case 'http':
    case 'h2':
      return clean({ type: 'http', host: list(s.host), path: s.path })
    case 'httpupgrade':
      return clean({ type: 'httpupgrade', host: s.host, path: s.path || '/' })
    case 'quic':
      return { type: 'quic' }
    default:
      return null
  }
}

/** Один профиль NekoBox → outbound sing-box. null — пропускаем. */
export function nekoBeanToOutbound(type: string, b: Dict): Outbound | null {
  const s: Dict = b.stream ?? {}
  const base = { server: b.addr, server_port: b.port }
  if (!b.addr || !b.port) return null
  switch (type) {
    case 'vless':
    case 'trojan':
    case 'vmess': {
      if (type !== 'vmess' && XRAY_TRANSPORTS.has(String(s.net))) {
        // xhttp ведёт Xray; reality у NekoBox — это sec=tls плюс ключ pbk
        return makeXray(type as 'vless' | 'trojan', String(b.addr), Number(b.port), String(b.pass ?? ''), {
          type: 'xhttp',
          security: s.pbk ? 'reality' : String(s.sec || 'none'),
          sni: s.sni,
          fp: s.utls,
          pbk: s.pbk,
          sid: s.sid,
          alpn: s.alpn,
          path: s.path,
          host: s.host,
          mode: s.xhttp_mode,
          extra: s.xhttp_extra,
          allowInsecure: s.insecure ? '1' : '',
          flow: b.flow
        })
      }
      const transport = transportFrom(s)
      if (transport === null) return null
      const tls = tlsFrom(s)
      if (type === 'vless') {
        return clean({ type, ...base, uuid: b.pass, flow: b.flow, packet_encoding: s.pac_enc, tls, transport })
      }
      if (type === 'trojan') return clean({ type, ...base, password: b.pass, tls, transport })
      return clean({ type, ...base, uuid: b.pass ?? b.id, security: b.sec || 'auto', alter_id: b.aid ?? 0, tls, transport })
    }
    case 'shadowsocks':
      return clean({ type, ...base, method: b.method, password: b.pass ?? b.password, plugin: b.plugin || undefined })
    case 'socks':
    case 'http': {
      const tls = tlsFrom(s)
      const auth = { username: b.username, password: b.password }
      if (type === 'http') return clean({ type, ...base, ...auth, tls })
      const v = String(b.v ?? 5)
      return clean({ type, ...base, version: v === '4' || v === '4a' ? v : '5', ...auth })
    }
    case 'hysteria2': {
      const hop = String(b.serverPorts ?? b.server_ports ?? '').trim()
      return clean({
        type,
        ...base,
        server_ports: hop
          ? hop.split(',').map((r) => {
              const [a, c] = r.trim().split('-')
              return `${a}:${c ?? a}`
            })
          : undefined,
        hop_interval: hop && b.hopInterval ? `${b.hopInterval}s` : undefined,
        password: b.password,
        up_mbps: b.uploadMbps || undefined,
        down_mbps: b.downloadMbps || undefined,
        obfs: b.obfsPassword ? { type: 'salamander', password: b.obfsPassword } : undefined,
        tls: clean({
          enabled: true,
          server_name: b.sni,
          insecure: b.allowInsecure || undefined,
          disable_sni: b.disableSni || undefined,
          alpn: list(b.alpn)
        })
      })
    }
    case 'tuic':
      return clean({
        type,
        ...base,
        uuid: b.uuid,
        password: b.password,
        congestion_control: b.congestionControl,
        udp_relay_mode: b.udpRelayMode,
        tls: clean({
          enabled: true,
          server_name: b.sni,
          insecure: b.allowInsecure || undefined,
          disable_sni: b.disableSni || undefined,
          alpn: list(b.alpn)
        })
      })
    default:
      return null
  }
}

export function importNekobox(configDir: string): NekoImport {
  const groups: NekoImport['groups'] = []
  const gdir = join(configDir, 'groups')
  for (const f of jsonFiles(gdir)) {
    if (f === 'nekobox.json' || f === 'pm.json') continue
    const g = readJson(join(gdir, f))
    if (!g || typeof g.id !== 'number') continue
    groups.push(clean({ nekoId: g.id, name: String(g.name || `Группа ${g.id}`), url: g.url || undefined }))
  }
  groups.sort((a, b) => a.nekoId - b.nekoId)

  const profiles: NekoImport['profiles'] = []
  let skipped = 0
  const pdir = join(configDir, 'profiles')
  for (const f of jsonFiles(pdir)) {
    const p = readJson(join(pdir, f))
    const bean = p?.bean
    const outbound = p && bean ? nekoBeanToOutbound(String(p.type), bean) : null
    if (!p || !outbound) {
      skipped++
      continue
    }
    profiles.push({
      nekoGroupId: typeof p.gid === 'number' ? p.gid : 0,
      name: String(bean.name || `${bean.addr}:${bean.port}`),
      outbound
    })
  }
  return { groups, profiles, skipped }
}
