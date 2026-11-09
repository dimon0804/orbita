// Серверы, которые sing-box не умеет (транспорт xhttp), уходят во второе ядро — Xray.
// Профиль хранит параметры в виде query-строки ссылки: из неё строится и outbound Xray,
// и обратная ссылка для QR/копирования. Чистый TS, работает в main и renderer.

import type { Outbound } from './types'

type Dict = Record<string, unknown>

/** Транспорты, ради которых поднимаем Xray. */
export const XRAY_TRANSPORTS = new Set(['xhttp', 'splithttp'])

export interface XrayOutbound extends Outbound {
  type: 'xray'
  protocol: 'vless' | 'trojan'
  server: string
  server_port: number
  /** uuid для VLESS, пароль для Trojan */
  credential: string
  /** Параметры ссылки как есть: type, security, sni, pbk, path, mode, extra… */
  query: Record<string, string>
}

export function isXray(o: Outbound): o is XrayOutbound {
  return o.type === 'xray'
}

export function makeXray(
  protocol: XrayOutbound['protocol'],
  server: string,
  port: number,
  credential: string,
  query: Record<string, string>
): XrayOutbound {
  const q: Record<string, string> = {}
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q[k] = v
  return { type: 'xray', protocol, server, server_port: port, credential, query: q }
}

function list(v: string | undefined): string[] | undefined {
  const l = v?.split(',').map((x) => x.trim()).filter(Boolean)
  return l?.length ? l : undefined
}

function clean(o: Dict): Dict {
  const out: Dict = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== null) out[k] = v
  return out
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true'
}

/** Outbound для конфига Xray. */
export function xrayOutboundJson(o: XrayOutbound, tag = 'proxy'): Dict {
  const q = o.query
  const security = (q.security || (o.protocol === 'trojan' ? 'tls' : 'none')).toLowerCase()
  const network = (q.type || 'tcp').toLowerCase() === 'splithttp' ? 'xhttp' : (q.type || 'tcp').toLowerCase()

  let extra: unknown
  if (q.extra) {
    try {
      extra = JSON.parse(q.extra)
    } catch {
      extra = undefined // битый extra не должен ронять весь профиль
    }
  }

  const stream: Dict = { network, security }
  if (network === 'xhttp') {
    stream.xhttpSettings = clean({ path: q.path || '/', host: q.host, mode: q.mode || 'auto', extra })
  }
  if (security === 'reality') {
    stream.realitySettings = clean({
      serverName: q.sni,
      fingerprint: q.fp || 'chrome',
      publicKey: q.pbk,
      shortId: q.sid,
      spiderX: q.spx
    })
  } else if (security === 'tls') {
    stream.tlsSettings = clean({
      serverName: q.sni,
      alpn: list(q.alpn),
      fingerprint: q.fp && q.fp !== 'none' ? q.fp : undefined,
      allowInsecure: truthy(q.allowInsecure) || truthy(q.insecure) || undefined
    })
  }

  const settings =
    o.protocol === 'vless'
      ? {
          vnext: [
            {
              address: o.server,
              port: o.server_port,
              users: [clean({ id: o.credential, encryption: q.encryption || 'none', flow: q.flow })]
            }
          ]
        }
      : { servers: [{ address: o.server, port: o.server_port, password: o.credential }] }

  return { tag, protocol: o.protocol, settings, streamSettings: stream }
}

/** Конфиг Xray: на каждый профиль свой локальный SOCKS-вход, который ведёт в его сервер. */
export function buildXrayConfig(items: { id: string; outbound: XrayOutbound; port: number }[], logLevel = 'warning'): Dict {
  return {
    log: { loglevel: logLevel },
    inbounds: items.map((it, i) => ({
      tag: `in-${i}`,
      listen: '127.0.0.1',
      port: it.port,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: true, ip: '127.0.0.1' }
    })),
    outbounds: [...items.map((it, i) => xrayOutboundJson(it.outbound, `out-${i}`)), { tag: 'direct', protocol: 'freedom' }],
    routing: { rules: items.map((_, i) => ({ type: 'field', inboundTag: [`in-${i}`], outboundTag: `out-${i}` })) }
  }
}

export function xrayToLink(o: XrayOutbound, name: string): string {
  const host = o.server.includes(':') ? `[${o.server}]` : o.server
  const qs = Object.entries(o.query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
  return `${o.protocol}://${encodeURIComponent(o.credential)}@${host}:${o.server_port}${qs ? '?' + qs : ''}#${encodeURIComponent(name)}`
}
