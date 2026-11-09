// Разбор и сборка ссылок прокси, подписок и заголовка subscription-userinfo.
// Чистый TS без node-зависимостей: работает и в renderer, и в main.
// Формат outbound — sing-box 1.14 (без tag).
//
// Особые случаи:
//  - VLESS/Trojan с транспортом xhttp/splithttp — профиль типа 'xray', его ведёт второе ядро (см. xray.ts);
//  - wireguard:// и .conf — профиль типа 'wireguard'; в sing-box 1.14 это endpoint, а не outbound,
//    сборщик конфига переносит его в endpoints.
// Не поддерживается (parseLink вернёт null): kcp и прочие транспорты Xray, ss-плагины,
// кроме obfs-local (simple-obfs) и v2ray-plugin.

import { parse as parseYaml } from 'yaml'
import type { Outbound, ParsedProfile, SubscriptionInfo } from './types'
import { XRAY_TRANSPORTS, isXray, makeXray, xrayToLink } from './xray'

type Dict = Record<string, unknown>

// ---------- base64 ----------

/** base64 / base64url, с паддингом и без. Бросает исключение на мусоре. */
export function b64decode(input: string): string {
  let s = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (s.length % 4 === 1) throw new Error('bad base64')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function b64encode(text: string, urlSafe = false): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  const out = btoa(bin)
  return urlSafe ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : out
}

function tryB64(s: string): string | null {
  try {
    return b64decode(s)
  } catch {
    return null
  }
}

// ---------- утилиты ----------

function dec(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const enc = encodeURIComponent

/** Убирает undefined, пустые строки, пустые массивы и пустые объекты (рекурсивно). */
function clean<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clean) as T
  if (v && typeof v === 'object') {
    const out: Dict = {}
    for (const [k, val] of Object.entries(v as Dict)) {
      const c = clean(val)
      if (c === undefined || c === '' || c === null) continue
      if (Array.isArray(c) && c.length === 0) continue
      if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length === 0) continue
      out[k] = c
    }
    return out as T
  }
  return v
}

function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return ['1', 'true', 'yes'].includes(v.toLowerCase())
  return false
}

function toInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) ? n : undefined
}

function splitList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  if (typeof v === 'string' && v) return v.split(',').map((x) => x.trim()).filter(Boolean)
  return undefined
}

function str(v: unknown): string | undefined {
  return v === undefined || v === null || v === '' ? undefined : String(v)
}

interface Uri {
  scheme: string
  userinfo?: string // в сыром виде, без декодирования
  host: string
  port: string
  path: string
  query: Record<string, string>
  fragment: string
}

/** Простой разбор URI: свой, потому что URL() по-разному ведёт себя с нестандартными схемами. */
function parseUri(link: string): Uri | null {
  const m = /^([a-z0-9+.-]+):\/\/(.*)$/is.exec(link.trim())
  if (!m) return null
  const scheme = m[1].toLowerCase()
  let rest = m[2]
  let fragment = ''
  const hashAt = rest.indexOf('#')
  if (hashAt >= 0) {
    fragment = dec(rest.slice(hashAt + 1))
    rest = rest.slice(0, hashAt)
  }
  const query: Record<string, string> = {}
  const qAt = rest.indexOf('?')
  if (qAt >= 0) {
    for (const part of rest.slice(qAt + 1).split('&')) {
      if (!part) continue
      const eq = part.indexOf('=')
      const k = dec(eq >= 0 ? part.slice(0, eq) : part)
      query[k] = eq >= 0 ? dec(part.slice(eq + 1)) : ''
    }
    rest = rest.slice(0, qAt)
  }
  const slashAt = rest.indexOf('/')
  const authority = slashAt >= 0 ? rest.slice(0, slashAt) : rest
  const path = slashAt >= 0 ? rest.slice(slashAt) : ''
  const atAt = authority.lastIndexOf('@')
  const userinfo = atAt >= 0 ? authority.slice(0, atAt) : undefined
  const hostport = atAt >= 0 ? authority.slice(atAt + 1) : authority
  let host: string
  let port = ''
  if (hostport.startsWith('[')) {
    const end = hostport.indexOf(']')
    if (end < 0) return null
    host = hostport.slice(1, end)
    if (hostport[end + 1] === ':') port = hostport.slice(end + 2)
  } else {
    const c = hostport.indexOf(':')
    host = c >= 0 ? hostport.slice(0, c) : hostport
    port = c >= 0 ? hostport.slice(c + 1) : ''
  }
  if (!host) return null
  return { scheme, userinfo, host: dec(host), port, path, query, fragment }
}

function hostForUri(h: string): string {
  return h.includes(':') ? `[${h}]` : h
}

function nameOf(u: { fragment?: string; host: string; port: string | number }): string {
  return u.fragment || `${u.host}:${u.port}`
}

function validPort(p: unknown): number | null {
  const n = toInt(p)
  return n !== undefined && n > 0 && n < 65536 && /^\d+$/.test(String(p).trim()) ? n : null
}

// ---------- общие куски: TLS и транспорт ----------

interface TlsSpec {
  sni?: string
  insecure?: boolean
  alpn?: string[]
  fp?: string
  pbk?: string
  sid?: string
  disableSni?: boolean
}

function buildTls(t: TlsSpec, reality = false): Dict {
  const fp = t.fp && t.fp !== 'none' ? t.fp : reality ? 'chrome' : undefined // reality без uTLS ядро не принимает
  return clean({
    enabled: true,
    server_name: t.sni,
    disable_sni: t.disableSni || undefined,
    insecure: t.insecure || undefined,
    alpn: t.alpn,
    utls: fp ? { enabled: true, fingerprint: fp } : undefined,
    reality: reality ? { enabled: true, public_key: t.pbk, short_id: t.sid } : undefined
  })
}

interface TransportSpec {
  type?: string
  path?: string
  host?: string
  serviceName?: string
}

/** undefined — без транспорта, null — транспорт не поддерживается ядром. */
function buildTransport(t: TransportSpec): Dict | undefined | null {
  const type = (t.type || 'tcp').toLowerCase()
  switch (type) {
    case 'tcp':
    case 'raw':
    case 'none':
      return undefined
    case 'ws':
    case 'websocket': {
      let path = t.path || '/'
      let ed: number | undefined
      // ?ed=2048 в пути — early data в стиле Xray
      const m = /[?&]ed=(\d+)/.exec(path)
      if (m) {
        ed = parseInt(m[1], 10)
        path = path.replace(/[?&]ed=\d+/, '').replace(/\?$/, '') || '/'
      }
      return clean({
        type: 'ws',
        path,
        headers: t.host ? { Host: t.host } : undefined,
        max_early_data: ed,
        early_data_header_name: ed ? 'Sec-WebSocket-Protocol' : undefined
      })
    }
    case 'grpc':
      return clean({ type: 'grpc', service_name: t.serviceName || t.path })
    case 'http':
    case 'h2':
      return clean({ type: 'http', host: splitList(t.host), path: t.path })
    case 'httpupgrade':
      return clean({ type: 'httpupgrade', host: t.host, path: t.path || '/' })
    case 'quic':
      return { type: 'quic' }
    default:
      return null // xhttp, splithttp, kcp и т.п.
  }
}

/** Параметры ссылки VLESS/Trojan/VMess(URI) → tls + transport. null — не поддерживается. */
function streamFromQuery(q: Record<string, string>, defaultSecurity: string): Dict | null {
  const security = (q.security || defaultSecurity).toLowerCase()
  const transport = buildTransport({
    type: q.type,
    path: q.path,
    host: q.host,
    serviceName: q.serviceName || q.servicename
  })
  if (transport === null) return null
  const out: Dict = {}
  if (security === 'tls' || security === 'xtls' || security === 'reality') {
    out.tls = buildTls(
      {
        sni: q.sni || q.peer,
        insecure: truthy(q.allowInsecure) || truthy(q.insecure),
        alpn: splitList(q.alpn),
        fp: q.fp,
        pbk: q.pbk,
        sid: q.sid
      },
      security === 'reality'
    )
  }
  if (transport) out.transport = transport
  return out
}

// ---------- отдельные протоколы ----------

function viaXray(u: Uri, protocol: 'vless' | 'trojan', port: number): ParsedProfile | null {
  if (!XRAY_TRANSPORTS.has((u.query.type || '').toLowerCase())) return null
  return { name: nameOf(u), outbound: makeXray(protocol, u.host, port, dec(u.userinfo!), u.query) }
}

function parseVless(u: Uri): ParsedProfile | null {
  const port = validPort(u.port)
  if (!port || !u.userinfo) return null
  const x = viaXray(u, 'vless', port)
  if (x) return x
  const stream = streamFromQuery(u.query, 'none')
  if (!stream) return null
  const ob: Outbound = clean({
    type: 'vless',
    server: u.host,
    server_port: port,
    uuid: dec(u.userinfo),
    flow: u.query.flow || undefined,
    packet_encoding: u.query.packetEncoding || undefined,
    ...stream
  })
  return { name: nameOf(u), outbound: ob }
}

function parseTrojan(u: Uri): ParsedProfile | null {
  const port = validPort(u.port)
  if (!port || !u.userinfo) return null
  const x = viaXray(u, 'trojan', port)
  if (x) return x
  const stream = streamFromQuery(u.query, 'tls')
  if (!stream) return null
  const ob: Outbound = clean({
    type: 'trojan',
    server: u.host,
    server_port: port,
    password: dec(u.userinfo),
    ...stream
  })
  return { name: nameOf(u), outbound: ob }
}

function parseVmess(link: string): ParsedProfile | null {
  const body = link.slice('vmess://'.length)
  const raw = tryB64(body.split('#')[0])
  let j: Dict | null = null
  if (raw) {
    try {
      j = JSON.parse(raw)
    } catch {
      j = null
    }
  }
  if (!j) {
    // vmess://uuid@host:port?... — формат «как у VLESS»
    const u = parseUri(link)
    if (!u || !u.userinfo) return null
    const port = validPort(u.port)
    if (!port) return null
    const stream = streamFromQuery(u.query, 'none')
    if (!stream) return null
    return {
      name: nameOf(u),
      outbound: clean({
        type: 'vmess',
        server: u.host,
        server_port: port,
        uuid: dec(u.userinfo),
        security: u.query.encryption || 'auto',
        alter_id: toInt(u.query.alterId) ?? 0,
        ...stream
      })
    }
  }
  const server = str(j.add)
  const port = validPort(j.port)
  if (!server || !port || !j.id) return null
  const net = str(j.net) || 'tcp'
  let transport: Dict | undefined | null
  if (net === 'tcp' && j.type === 'http') {
    transport = undefined // obfs-заголовок HTTP поверх TCP в sing-box не поддерживается, идём без него
  } else {
    transport = buildTransport({ type: net, path: str(j.path), host: str(j.host), serviceName: str(j.path) })
  }
  if (transport === null) return null
  const tlsMode = str(j.tls)
  const ob: Outbound = clean({
    type: 'vmess',
    server,
    server_port: port,
    uuid: String(j.id),
    security: str(j.scy) || 'auto',
    alter_id: toInt(j.aid) ?? 0,
    tls:
      tlsMode === 'tls' || tlsMode === 'reality'
        ? buildTls(
            {
              sni: str(j.sni) || undefined,
              insecure: truthy(j.allowInsecure) || truthy(j.skipCertVerify),
              alpn: splitList(j.alpn),
              fp: str(j.fp),
              pbk: str(j.pbk),
              sid: str(j.sid)
            },
            tlsMode === 'reality'
          )
        : undefined,
    transport
  })
  return { name: str(j.ps) || `${server}:${port}`, outbound: ob }
}

/** "obfs-local;obfs=http;obfs-host=x" → plugin + plugin_opts. null — плагин не поддерживается. */
function ssPlugin(spec: string | undefined): Dict | null {
  if (!spec) return {}
  const parts = spec.split(';')
  let plugin = parts[0]
  if (plugin === 'simple-obfs' || plugin === 'obfs') plugin = 'obfs-local'
  if (plugin !== 'obfs-local' && plugin !== 'v2ray-plugin') return null
  return clean({ plugin, plugin_opts: parts.slice(1).join(';') })
}

function parseSs(link: string): ParsedProfile | null {
  let body = link.slice('ss://'.length)
  let fragment = ''
  const h = body.indexOf('#')
  if (h >= 0) {
    fragment = dec(body.slice(h + 1))
    body = body.slice(0, h)
  }
  if (!body.includes('@')) {
    // старый формат: ss://base64(method:password@host:port)
    const qAt = body.indexOf('?')
    const decoded = tryB64(qAt >= 0 ? body.slice(0, qAt) : body.replace(/\/$/, ''))
    if (!decoded) return null
    body = decoded + (qAt >= 0 ? body.slice(qAt) : '')
    const at = decoded.lastIndexOf('@')
    if (at < 0) return null
    const cred = decoded.slice(0, at)
    const c = cred.indexOf(':')
    if (c < 0) return null
    // userinfo перекодируем, чтобы parseUri не споткнулся о спецсимволы пароля
    body = enc(cred.slice(0, c)) + ':' + enc(cred.slice(c + 1)) + body.slice(at)
  }
  const u = parseUri('ss://' + body)
  if (!u || !u.userinfo) return null
  const port = validPort(u.port)
  if (!port) return null
  let cred = dec(u.userinfo)
  if (!cred.includes(':')) {
    const d = tryB64(cred)
    if (!d || !d.includes(':')) return null
    cred = d
  }
  const c = cred.indexOf(':')
  const plugin = ssPlugin(u.query.plugin)
  if (!plugin) return null
  const ob: Outbound = clean({
    type: 'shadowsocks',
    server: u.host,
    server_port: port,
    method: cred.slice(0, c),
    password: cred.slice(c + 1),
    ...plugin
  })
  return { name: fragment || `${u.host}:${port}`, outbound: ob }
}

/** "443,20000-30000" → server_ports ["443:443","20000:30000"]. */
function portRanges(spec: string): string[] {
  return spec
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [a, b] = x.split('-')
      return `${a}:${b ?? a}`
    })
}

function parseHy2(u: Uri): ParsedProfile | null {
  const q = u.query
  let port: number | null = validPort(u.port)
  let ports: string[] | undefined
  if (!port && /^[\d,\s-]+$/.test(u.port)) {
    // порт-хоппинг прямо в адресе: host:443,20000-30000
    ports = portRanges(u.port)
    const single = u.port.split(',').find((x) => /^\d+$/.test(x.trim()))
    port = single ? validPort(single) : null
  }
  if (q.mport) ports = portRanges(q.mport)
  if (!port && !ports) return null
  const hop = q.hop_interval || q.hopInterval
  const ob: Outbound = clean({
    type: 'hysteria2',
    server: u.host,
    server_port: port ?? undefined,
    server_ports: ports,
    hop_interval: hop ? (/^\d+$/.test(hop) ? `${hop}s` : hop) : undefined,
    password: u.userinfo !== undefined ? dec(u.userinfo) : q.auth,
    up_mbps: toInt(q.upmbps || q.up),
    down_mbps: toInt(q.downmbps || q.down),
    obfs:
      q.obfs === 'salamander' && q['obfs-password']
        ? { type: 'salamander', password: q['obfs-password'] }
        : undefined,
    tls: buildTls({ sni: q.sni || q.peer, insecure: truthy(q.insecure) || truthy(q.allowInsecure), alpn: splitList(q.alpn) })
  })
  return { name: nameOf({ fragment: u.fragment, host: u.host, port: port ?? u.port }), outbound: ob }
}

function parseHysteria(u: Uri): ParsedProfile | null {
  const q = u.query
  const port = validPort(u.port)
  if (!port) return null
  if (q.protocol && q.protocol !== 'udp') return null // faketcp/wechat-video ядро не умеет
  const ob: Outbound = clean({
    type: 'hysteria',
    server: u.host,
    server_port: port,
    server_ports: q.mport ? portRanges(q.mport) : undefined,
    auth_str: q.auth,
    // без скоростей ядро не стартует — подставляем скромные значения
    up_mbps: toInt(q.upmbps) ?? 10,
    down_mbps: toInt(q.downmbps) ?? 50,
    obfs: q.obfsParam || q.obfs_password || undefined,
    tls: buildTls({ sni: q.peer || q.sni, insecure: truthy(q.insecure), alpn: splitList(q.alpn) })
  })
  return { name: nameOf(u), outbound: ob }
}

function parseTuic(u: Uri): ParsedProfile | null {
  const q = u.query
  const port = validPort(u.port)
  if (!port || !u.userinfo) return null
  const info = dec(u.userinfo)
  const c = info.indexOf(':')
  const ob: Outbound = clean({
    type: 'tuic',
    server: u.host,
    server_port: port,
    uuid: c >= 0 ? info.slice(0, c) : info,
    password: c >= 0 ? info.slice(c + 1) : q.password,
    congestion_control: q.congestion_control || q.congestion_controller,
    udp_relay_mode: q.udp_relay_mode,
    tls: buildTls({
      sni: q.sni,
      insecure: truthy(q.allow_insecure) || truthy(q.insecure) || truthy(q.allowInsecure),
      alpn: splitList(q.alpn),
      disableSni: truthy(q.disable_sni)
    })
  })
  return { name: nameOf(u), outbound: ob }
}

/** user:pass из userinfo; v2rayN кладёт туда base64(user:pass). */
function userPass(userinfo: string | undefined): { username?: string; password?: string } {
  if (userinfo === undefined) return {}
  let raw = userinfo
  if (!raw.includes(':')) {
    const d = tryB64(raw)
    if (d && d.includes(':')) raw = d
    else return { username: dec(raw) }
  } else {
    const c = raw.indexOf(':')
    return { username: dec(raw.slice(0, c)), password: dec(raw.slice(c + 1)) }
  }
  const c = raw.indexOf(':')
  return { username: raw.slice(0, c), password: raw.slice(c + 1) }
}

function parseSocks(u: Uri): ParsedProfile | null {
  const port = validPort(u.port)
  if (!port) return null
  const version = u.scheme === 'socks4' ? '4' : u.scheme === 'socks4a' ? '4a' : '5'
  const ob: Outbound = clean({
    type: 'socks',
    server: u.host,
    server_port: port,
    version,
    ...userPass(u.userinfo)
  })
  return { name: nameOf(u), outbound: ob }
}

function parseHttp(u: Uri): ParsedProfile | null {
  // Без явного порта и с путём — это скорее ссылка на сайт/подписку, а не прокси.
  const port = validPort(u.port)
  if (!port || (u.path && u.path !== '/')) return null
  const ob: Outbound = clean({
    type: 'http',
    server: u.host,
    server_port: port,
    ...userPass(u.userinfo),
    tls:
      u.scheme === 'https'
        ? buildTls({ sni: u.query.sni, insecure: truthy(u.query.insecure) || truthy(u.query.allowInsecure) })
        : undefined
  })
  return { name: nameOf(u), outbound: ob }
}

/** Адрес интерфейса без маски получает /32 или /128 — иначе sing-box его не примет. */
function withMask(a: string): string {
  if (a.includes('/')) return a
  return a.includes(':') ? `${a}/128` : `${a}/32`
}

function wgReserved(v: string | undefined): number[] | undefined {
  if (!v) return undefined
  const nums = v.split(',').map((x) => Number(x.trim()))
  if (nums.length === 3 && nums.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) return nums
  try {
    const b = b64decode(v) // reserved в base64 (WARP-ссылки)
    if (b.length === 3) return [...b].map((c) => c.charCodeAt(0))
  } catch {
    /* не base64 */
  }
  return undefined
}

function wgOutbound(o: {
  server: string
  port: number
  privateKey?: string
  publicKey?: string
  psk?: string
  address?: string
  mtu?: string
  reserved?: string
}): Outbound | null {
  if (!o.privateKey || !o.publicKey) return null
  const addr = (o.address || '').split(',').map((x) => x.trim()).filter(Boolean).map(withMask)
  return clean({
    type: 'wireguard',
    server: o.server,
    server_port: o.port,
    private_key: o.privateKey,
    peer_public_key: o.publicKey,
    pre_shared_key: o.psk,
    local_address: addr.length ? addr : ['172.16.0.2/32'],
    mtu: toInt(o.mtu),
    reserved: wgReserved(o.reserved)
  })
}

function parseWireguard(u: Uri): ParsedProfile | null {
  const port = validPort(u.port)
  if (!port || !u.userinfo) return null
  const q = Object.fromEntries(Object.entries(u.query).map(([k, v]) => [k.toLowerCase().replace(/[_-]/g, ''), v]))
  const ob = wgOutbound({
    server: u.host,
    port,
    privateKey: dec(u.userinfo),
    publicKey: q.publickey || q.peerpublickey,
    psk: q.presharedkey || q.psk,
    address: q.address || q.ip || q.localaddress,
    mtu: q.mtu,
    reserved: q.reserved
  })
  return ob ? { name: nameOf(u), outbound: ob } : null
}

/** Файл .conf WireGuard ([Interface] + [Peer]) → профиль. */
export function parseWireguardConf(text: string, name = 'WireGuard'): ParsedProfile | null {
  const sec: Record<string, Record<string, string>> = {}
  let cur = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, '').trim()
    if (!line) continue
    const h = /^\[(\w+)\]$/.exec(line)
    if (h) {
      cur = h[1].toLowerCase()
      if (!sec[cur]) sec[cur] = {} // берём первый [Peer]
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0 || !cur) continue
    const k = line.slice(0, eq).trim().toLowerCase()
    if (!(k in sec[cur])) sec[cur][k] = line.slice(eq + 1).trim()
  }
  const i = sec.interface
  const p = sec.peer
  if (!i || !p?.endpoint) return null
  const ep = /^\[?([^\]]+?)\]?:(\d+)$/.exec(p.endpoint)
  const port = ep ? validPort(ep[2]) : null
  if (!ep || !port) return null
  const ob = wgOutbound({
    server: ep[1],
    port,
    privateKey: i.privatekey,
    publicKey: p.publickey,
    psk: p.presharedkey,
    address: i.address,
    mtu: i.mtu
  })
  return ob ? { name, outbound: ob } : null
}

function parseAnytls(u: Uri): ParsedProfile | null {
  const port = validPort(u.port)
  if (!port || !u.userinfo) return null
  const q = u.query
  const ob: Outbound = clean({
    type: 'anytls',
    server: u.host,
    server_port: port,
    password: dec(u.userinfo),
    tls: buildTls({ sni: q.sni, insecure: truthy(q.insecure) || truthy(q.allowInsecure), alpn: splitList(q.alpn), fp: q.fp })
  })
  return { name: nameOf(u), outbound: ob }
}

// ---------- публичное API ----------

/** Ссылка → профиль. null — формат не распознан или не поддерживается ядром. */
export function parseLink(link: string): ParsedProfile | null {
  const s = link.trim()
  const scheme = /^([a-z0-9+.-]+):\/\//i.exec(s)?.[1]?.toLowerCase()
  if (!scheme) return null
  try {
    if (scheme === 'vmess') return parseVmess(s)
    if (scheme === 'ss') return parseSs(s)
    const u = parseUri(s)
    if (!u) return null
    switch (scheme) {
      case 'vless':
        return parseVless(u)
      case 'trojan':
        return parseTrojan(u)
      case 'hysteria2':
      case 'hy2':
        return parseHy2(u)
      case 'hysteria':
        return parseHysteria(u)
      case 'tuic':
        return parseTuic(u)
      case 'socks':
      case 'socks5':
      case 'socks4':
      case 'socks4a':
        return parseSocks(u)
      case 'http':
      case 'https':
        return parseHttp(u)
      case 'anytls':
        return parseAnytls(u)
      case 'wireguard':
      case 'wg':
        return parseWireguard(u)
      default:
        return null
    }
  } catch {
    return null
  }
}

// wireguard-outbound в 1.14 убран (только endpoint) — тоже пропускаем
const SERVICE_TYPES = new Set(['direct', 'block', 'dns', 'selector', 'urltest', 'wireguard'])

function fromSingbox(j: Dict): ParsedProfile[] {
  const list = Array.isArray(j.outbounds) ? (j.outbounds as Dict[]) : []
  const out: ParsedProfile[] = []
  for (const e of Array.isArray(j.endpoints) ? (j.endpoints as Dict[]) : []) {
    if (e?.type !== 'wireguard') continue
    const peer = (Array.isArray(e.peers) ? (e.peers as Dict[]) : [])[0]
    if (!peer?.address || !peer.port) continue
    out.push({
      name: str(e.tag) || `${peer.address}:${peer.port}`,
      outbound: clean({
        type: 'wireguard',
        server: str(peer.address),
        server_port: toInt(peer.port),
        private_key: str(e.private_key),
        peer_public_key: str(peer.public_key),
        pre_shared_key: str(peer.pre_shared_key),
        local_address: Array.isArray(e.address) ? (e.address as string[]) : splitList(e.address),
        mtu: toInt(e.mtu),
        reserved: Array.isArray(peer.reserved) ? (peer.reserved as number[]) : undefined
      }) as Outbound
    })
  }
  for (const o of list) {
    if (!o || typeof o.type !== 'string' || SERVICE_TYPES.has(o.type)) continue
    const { tag, detour: _detour, ...rest } = o // detour ссылается на чужой tag — выкидываем
    const name = str(tag) || `${str(rest.server) ?? o.type}:${str(rest.server_port) ?? ''}`
    out.push({ name, outbound: rest as Outbound })
  }
  return out
}

// ---------- Xray JSON (то, что панели отдают v2rayN) ----------

/** streamSettings Xray → query-параметры ссылки. */
function xrayStreamQuery(st: Dict): Record<string, string> {
  const q: Record<string, string> = {}
  const set = (k: string, v: unknown): void => {
    const sv = Array.isArray(v) ? v.join(',') : str(v)
    if (sv) q[k] = sv
  }
  let net = (str(st.network) || 'tcp').toLowerCase()
  if (net === 'raw') net = 'tcp'
  if (net === 'h2') net = 'http'
  set('type', net)
  const security = (str(st.security) || 'none').toLowerCase()
  set('security', security)
  const tls = (st.tlsSettings as Dict) || {}
  const reality = (st.realitySettings as Dict) || {}
  if (security === 'tls') {
    set('sni', tls.serverName)
    set('alpn', tls.alpn)
    set('fp', tls.fingerprint)
    if (truthy(tls.allowInsecure)) q.allowInsecure = '1'
  } else if (security === 'reality') {
    set('sni', reality.serverName)
    set('pbk', reality.publicKey ?? reality.password)
    set('sid', reality.shortId)
    set('spx', reality.spiderX)
    set('fp', reality.fingerprint)
  }
  const pick = (k: string): Dict => ((st[k] as Dict) || {}) as Dict
  const hostOf = (o: Dict): unknown => o.host ?? (o.headers as Dict | undefined)?.Host
  if (net === 'ws') {
    const o = pick('wsSettings')
    set('path', o.path)
    set('host', hostOf(o))
  } else if (net === 'grpc') {
    set('serviceName', pick('grpcSettings').serviceName)
  } else if (net === 'httpupgrade') {
    const o = pick('httpupgradeSettings')
    set('path', o.path)
    set('host', hostOf(o))
  } else if (net === 'http') {
    const o = { ...pick('httpSettings'), ...pick('h2Settings') }
    set('path', o.path)
    set('host', o.host)
  } else if (net === 'xhttp' || net === 'splithttp') {
    const o = { ...pick('splithttpSettings'), ...pick('xhttpSettings') }
    set('path', o.path)
    set('host', o.host)
    set('mode', o.mode)
    if (o.extra && typeof o.extra === 'object') q.extra = JSON.stringify(o.extra)
  }
  return q
}

function qsRaw(q: Record<string, string>): string {
  const parts = Object.entries(q).map(([k, v]) => `${enc(k)}=${enc(v)}`)
  return parts.length ? '?' + parts.join('&') : ''
}

/** Один outbound Xray → профиль (через ссылку, чтобы не дублировать разбор). */
function fromXrayOutbound(o: Dict, name: string): ParsedProfile | null {
  const proto = str(o.protocol)
  const set = (o.settings as Dict) || {}
  const st = (o.streamSettings as Dict) || {}
  // старая форма vnext/servers и новая плоская
  const node = ((set.vnext as Dict[])?.[0] ?? (set.servers as Dict[])?.[0] ?? set) as Dict
  const user = ((node.users as Dict[])?.[0] ?? node) as Dict
  const host = str(node.address)
  const port = toInt(node.port)
  if (!host || !port) return null
  const h = hostForUri(host)
  const q = xrayStreamQuery(st)
  let link: string | null = null
  if (proto === 'vless') {
    if (str(user.flow)) q.flow = str(user.flow)!
    if (str(user.encryption) && user.encryption !== 'none') q.encryption = str(user.encryption)!
    link = `vless://${enc(String(user.id))}@${h}:${port}${qsRaw(q)}`
  } else if (proto === 'trojan') {
    link = `trojan://${enc(String(user.password ?? node.password))}@${h}:${port}${qsRaw(q)}`
  } else if (proto === 'shadowsocks') {
    link = `ss://${enc(String(node.method))}:${enc(String(node.password))}@${h}:${port}`
  } else if (proto === 'vmess') {
    link =
      'vmess://' +
      b64encode(
        JSON.stringify(
          clean({
            v: '2', ps: name, add: host, port: String(port), id: user.id, aid: String(user.alterId ?? 0),
            scy: user.security ?? 'auto', net: q.type, type: 'none', host: q.host,
            path: q.type === 'grpc' ? q.serviceName : q.path,
            tls: q.security === 'none' ? '' : q.security, sni: q.sni, alpn: q.alpn, fp: q.fp
          })
        )
      )
  }
  if (!link) return null
  const p = parseLink(link)
  return p ? { ...p, name } : null
}

const XRAY_PROXY = new Set(['vless', 'trojan', 'vmess', 'shadowsocks'])

/** Xray JSON: один конфиг или массив конфигов (по серверу в каждом, имя в remarks). */
function fromXrayJson(j: unknown): ParsedProfile[] {
  const configs = (Array.isArray(j) ? j : [j]) as Dict[]
  const out: ParsedProfile[] = []
  for (const c of configs) {
    const obs = (Array.isArray(c?.outbounds) ? (c.outbounds as Dict[]) : []).filter((o) => XRAY_PROXY.has(String(o?.protocol)))
    // в конфиге бывают запасные цепочки (dialerProxy) — берём только outbound'ы верхнего уровня
    for (const o of obs) {
      const remark = str(c.remarks)
      const name = remark ? (obs.length > 1 ? `${remark} · ${str(o.tag) ?? ''}` : remark) : str(o.tag) ?? 'Xray'
      try {
        const p = fromXrayOutbound(o, name)
        if (p) out.push(p)
      } catch {
        /* битый outbound пропускаем */
      }
    }
  }
  return out
}

// ---------- Clash ----------

function clashTls(p: Dict, reality: boolean): Dict {
  const ro = (p['reality-opts'] as Dict) || {}
  return buildTls(
    {
      sni: str(p.servername) || str(p.sni),
      insecure: truthy(p['skip-cert-verify']),
      alpn: splitList(p.alpn),
      fp: str(p['client-fingerprint']),
      pbk: str(ro['public-key']),
      sid: str(ro['short-id'])
    },
    reality
  )
}

function clashTransport(p: Dict): Dict | undefined | null {
  const net = str(p.network) || 'tcp'
  if (net === 'ws') {
    const o = (p['ws-opts'] as Dict) || {}
    const headers = (o.headers as Dict) || {}
    const t = buildTransport({ type: 'ws', path: str(o.path), host: str(headers.Host ?? headers.host) })
    if (t && o['max-early-data']) {
      t.max_early_data = toInt(o['max-early-data'])
      t.early_data_header_name = str(o['early-data-header-name']) || 'Sec-WebSocket-Protocol'
    }
    return t
  }
  if (net === 'grpc') {
    const o = (p['grpc-opts'] as Dict) || {}
    return buildTransport({ type: 'grpc', serviceName: str(o['grpc-service-name']) })
  }
  if (net === 'h2') {
    const o = (p['h2-opts'] as Dict) || {}
    return buildTransport({ type: 'http', host: splitList(o.host)?.join(','), path: str(o.path) })
  }
  if (net === 'http') {
    const o = (p['http-opts'] as Dict) || {}
    const headers = (o.headers as Dict) || {}
    const path = Array.isArray(o.path) ? str(o.path[0]) : str(o.path)
    return buildTransport({ type: 'http', host: splitList(headers.Host)?.join(','), path })
  }
  return buildTransport({ type: net })
}

function clashSsPlugin(p: Dict): Dict | null {
  const plugin = str(p.plugin)
  if (!plugin) return {}
  const o = (p['plugin-opts'] as Dict) || {}
  if (plugin === 'obfs') {
    return clean({ plugin: 'obfs-local', plugin_opts: [`obfs=${o.mode ?? 'http'}`, o.host ? `obfs-host=${o.host}` : ''].filter(Boolean).join(';') })
  }
  if (plugin === 'v2ray-plugin') {
    const opts = [`mode=${o.mode ?? 'websocket'}`]
    if (truthy(o.tls)) opts.push('tls')
    if (o.host) opts.push(`host=${o.host}`)
    if (o.path) opts.push(`path=${o.path}`)
    return { plugin: 'v2ray-plugin', plugin_opts: opts.join(';') }
  }
  return null
}

function fromClashProxy(p: Dict): ParsedProfile | null {
  const type = str(p.type)
  const server = str(p.server)
  const port = validPort(p.port)
  if (!type || !server) return null
  const name = str(p.name) || `${server}:${p.port}`
  const base = { server, server_port: port ?? undefined }
  const reality = !!p['reality-opts']
  let ob: Dict | null = null
  switch (type) {
    case 'ss': {
      const plugin = clashSsPlugin(p)
      if (!plugin || !port) return null
      ob = { type: 'shadowsocks', ...base, method: p.cipher, password: str(p.password), ...plugin }
      break
    }
    case 'vmess':
    case 'vless': {
      const transport = clashTransport(p)
      if (transport === null || !port) return null
      ob = {
        type,
        ...base,
        uuid: str(p.uuid),
        ...(type === 'vmess'
          ? { security: str(p.cipher) || 'auto', alter_id: toInt(p.alterId) ?? 0 }
          : { flow: str(p.flow) }),
        tls: truthy(p.tls) || reality ? clashTls(p, reality) : undefined,
        transport
      }
      break
    }
    case 'trojan': {
      const transport = clashTransport(p)
      if (transport === null || !port) return null
      ob = { type, ...base, password: str(p.password), tls: clashTls(p, reality), transport }
      break
    }
    case 'hysteria2': {
      const ports = str(p.ports)
      if (!port && !ports) return null
      ob = {
        type,
        ...base,
        server_ports: ports ? portRanges(ports) : undefined,
        password: str(p.password),
        up_mbps: toInt(p.up),
        down_mbps: toInt(p.down),
        obfs: p.obfs === 'salamander' && p['obfs-password'] ? { type: 'salamander', password: str(p['obfs-password']) } : undefined,
        tls: clashTls(p, false)
      }
      break
    }
    case 'tuic': {
      if (!port) return null
      ob = {
        type,
        ...base,
        uuid: str(p.uuid),
        password: str(p.password),
        congestion_control: str(p['congestion-controller']),
        udp_relay_mode: str(p['udp-relay-mode']),
        tls: { ...clashTls(p, false), ...(truthy(p['disable-sni']) ? { disable_sni: true } : {}) }
      }
      break
    }
    case 'anytls': {
      if (!port) return null
      ob = { type, ...base, password: str(p.password), tls: clashTls(p, false) }
      break
    }
    case 'socks5':
    case 'http': {
      if (!port) return null
      ob = {
        type: type === 'socks5' ? 'socks' : 'http',
        ...base,
        ...(type === 'socks5' ? { version: '5' } : {}),
        username: str(p.username),
        password: str(p.password),
        tls: truthy(p.tls) ? clashTls(p, false) : undefined
      }
      break
    }
    default:
      return null
  }
  return { name, outbound: clean(ob) as Outbound }
}

function fromLines(text: string): ParsedProfile[] {
  const out: ParsedProfile[] = []
  for (const line of text.split(/\r?\n/)) {
    const p = parseLink(line)
    if (p) out.push(p)
  }
  return out
}

/** Текст подписки → профили. Понимает base64, построчные ссылки, sing-box JSON и Clash YAML. */
export function parseSubscription(text: string): ParsedProfile[] {
  const s = text.replace(/^﻿/, '').trim()
  if (!s) return []
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const j = JSON.parse(s)
      const isXrayJson = (Array.isArray(j) ? j : [j]).some(
        (c: Dict) => Array.isArray(c?.outbounds) && (c.outbounds as Dict[]).some((o) => typeof o?.protocol === 'string')
      )
      return isXrayJson ? fromXrayJson(j) : fromSingbox(j)
    } catch {
      /* не JSON — пробуем дальше */
    }
  }
  if (/^proxies\s*:/m.test(s)) {
    try {
      const y = parseYaml(s) as Dict
      if (y && Array.isArray(y.proxies)) {
        return (y.proxies as Dict[]).map(fromClashProxy).filter((x): x is ParsedProfile => !!x)
      }
    } catch {
      /* битый YAML */
    }
  }
  if (/^\s*\[Interface\]/im.test(s) && /^\s*\[Peer\]/im.test(s)) {
    const wg = parseWireguardConf(s)
    return wg ? [wg] : []
  }
  if (s.includes('://')) return fromLines(s)
  const decoded = tryB64(s)
  if (decoded && decoded.includes('://')) return fromLines(decoded)
  return []
}

// ---------- обратное преобразование ----------

function qs(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue
    parts.push(`${enc(k)}=${enc(String(v))}`)
  }
  return parts.length ? '?' + parts.join('&') : ''
}

function tail(name: string): string {
  return name ? '#' + enc(name) : ''
}

/** tls + transport → query-параметры в стиле VLESS/Trojan. */
function streamQuery(o: Dict, defaultSecurity: string): Record<string, unknown> {
  const tls = o.tls as Dict | undefined
  const tr = o.transport as Dict | undefined
  const reality = tls?.reality as Dict | undefined
  const utls = tls?.utls as Dict | undefined
  const security = tls?.enabled ? (reality?.enabled ? 'reality' : 'tls') : 'none'
  const q: Record<string, unknown> = {}
  q.type = tr?.type ?? 'tcp'
  if (security !== defaultSecurity) q.security = security
  if (tls?.enabled) {
    q.sni = tls.server_name
    q.alpn = Array.isArray(tls.alpn) ? tls.alpn.join(',') : undefined
    q.fp = utls?.enabled ? utls.fingerprint : undefined
    q.allowInsecure = tls.insecure ? 1 : undefined
    if (reality?.enabled) {
      q.pbk = reality.public_key
      q.sid = reality.short_id
    }
  }
  if (tr) {
    if (tr.type === 'ws') {
      const ed = toInt(tr.max_early_data)
      q.path = ed ? `${tr.path ?? '/'}?ed=${ed}` : tr.path
      q.host = (tr.headers as Dict | undefined)?.Host
    } else if (tr.type === 'grpc') {
      q.serviceName = tr.service_name
    } else if (tr.type === 'http') {
      q.host = Array.isArray(tr.host) ? tr.host.join(',') : tr.host
      q.path = tr.path
    } else if (tr.type === 'httpupgrade') {
      q.host = tr.host
      q.path = tr.path
    }
  }
  return q
}

function tlsSimpleQuery(tls: Dict | undefined): Record<string, unknown> {
  const utls = tls?.utls as Dict | undefined
  return {
    sni: tls?.server_name,
    alpn: Array.isArray(tls?.alpn) ? (tls!.alpn as string[]).join(',') : undefined,
    insecure: tls?.insecure ? 1 : undefined,
    fp: utls?.enabled ? utls.fingerprint : undefined
  }
}

/** Профиль → ссылка для «поделиться». null — тип не поддерживается. */
export function toLink(p: ParsedProfile): string | null {
  if (isXray(p.outbound)) return xrayToLink(p.outbound, p.name)
  const o = p.outbound as Dict
  const host = hostForUri(String(o.server ?? ''))
  const port = o.server_port
  const tls = o.tls as Dict | undefined
  switch (o.type) {
    case 'vless':
      return (
        `vless://${enc(String(o.uuid))}@${host}:${port}` +
        qs({ ...streamQuery(o, 'none'), flow: o.flow, packetEncoding: o.packet_encoding }) +
        tail(p.name)
      )
    case 'trojan':
      return `trojan://${enc(String(o.password))}@${host}:${port}` + qs(streamQuery(o, 'tls')) + tail(p.name)
    case 'vmess': {
      const q = streamQuery(o, 'none')
      const j = clean({
        v: '2',
        ps: p.name,
        add: o.server,
        port: String(port),
        id: o.uuid,
        aid: String(o.alter_id ?? 0),
        scy: o.security ?? 'auto',
        net: q.type,
        type: 'none',
        host: q.host,
        path: q.type === 'grpc' ? q.serviceName : q.path,
        tls: q.security === 'none' || q.security === undefined ? '' : q.security,
        sni: q.sni,
        alpn: q.alpn,
        fp: q.fp,
        pbk: q.pbk,
        sid: q.sid,
        allowInsecure: q.allowInsecure ? '1' : undefined
      })
      return 'vmess://' + b64encode(JSON.stringify(j))
    }
    case 'shadowsocks': {
      const method = String(o.method)
      const pass = String(o.password)
      // для 2022-шифров base64 не нужен (SIP022), для остальных — base64url
      const userinfo = method.startsWith('2022-')
        ? `${enc(method)}:${enc(pass)}`
        : b64encode(`${method}:${pass}`, true)
      const plugin = o.plugin ? [o.plugin, o.plugin_opts].filter(Boolean).join(';') : undefined
      return `ss://${userinfo}@${host}:${port}` + (plugin ? '/' + qs({ plugin }) : '') + tail(p.name)
    }
    case 'hysteria2': {
      const obfs = o.obfs as Dict | undefined
      const ports = Array.isArray(o.server_ports)
        ? (o.server_ports as string[]).map((r) => {
            const [a, b] = r.split(':')
            return a === b ? a : `${a}-${b}`
          })
        : undefined
      const hop = typeof o.hop_interval === 'string' ? o.hop_interval : undefined
      return (
        `hysteria2://${enc(String(o.password ?? ''))}@${host}:${port ?? ports?.[0]?.split('-')[0] ?? ''}/` +
        qs({
          ...tlsSimpleQuery(tls),
          obfs: obfs?.type,
          'obfs-password': obfs?.password,
          mport: ports?.join(','),
          hop_interval: hop,
          upmbps: o.up_mbps,
          downmbps: o.down_mbps
        }) +
        tail(p.name)
      )
    }
    case 'tuic':
      return (
        `tuic://${enc(String(o.uuid))}:${enc(String(o.password ?? ''))}@${host}:${port}` +
        qs({
          sni: tls?.server_name,
          alpn: Array.isArray(tls?.alpn) ? (tls!.alpn as string[]).join(',') : undefined,
          allow_insecure: tls?.insecure ? 1 : undefined,
          disable_sni: tls?.disable_sni ? 1 : undefined,
          congestion_control: o.congestion_control,
          udp_relay_mode: o.udp_relay_mode
        }) +
        tail(p.name)
      )
    case 'anytls':
      return `anytls://${enc(String(o.password))}@${host}:${port}` + qs(tlsSimpleQuery(tls)) + tail(p.name)
    case 'wireguard':
      return (
        `wireguard://${enc(String(o.private_key))}@${host}:${port}` +
        qs({
          publickey: o.peer_public_key,
          presharedkey: o.pre_shared_key,
          address: Array.isArray(o.local_address) ? (o.local_address as string[]).join(',') : undefined,
          mtu: o.mtu,
          reserved: Array.isArray(o.reserved) ? (o.reserved as number[]).join(',') : undefined
        }) +
        tail(p.name)
      )
    case 'socks':
    case 'http': {
      const scheme =
        o.type === 'http'
          ? tls?.enabled
            ? 'https'
            : 'http'
          : o.version === '4'
            ? 'socks4'
            : o.version === '4a'
              ? 'socks4a'
              : 'socks5'
      const auth =
        o.username !== undefined
          ? enc(String(o.username)) + (o.password !== undefined ? ':' + enc(String(o.password)) : '') + '@'
          : ''
      const q = o.type === 'http' && tls?.enabled ? qs({ sni: tls.server_name, insecure: tls.insecure ? 1 : undefined }) : ''
      return `${scheme}://${auth}${host}:${port}${q}` + tail(p.name)
    }
    default:
      return null
  }
}

/** Заголовок subscription-userinfo: "upload=1; download=2; total=3; expire=4". */
export function parseSubscriptionInfo(header: string | null): SubscriptionInfo | null {
  if (!header) return null
  const info: SubscriptionInfo = { upload: 0, download: 0, total: 0, expire: 0 }
  let found = false
  for (const part of header.split(/[;,]/)) {
    const [k, v] = part.split('=').map((x) => x?.trim())
    if (!k || v === undefined) continue
    const key = k.toLowerCase() as keyof SubscriptionInfo
    if (key in info) {
      const n = Number(v)
      if (Number.isFinite(n)) {
        info[key] = Math.max(0, Math.floor(n))
        found = true
      }
    }
  }
  return found ? info : null
}
