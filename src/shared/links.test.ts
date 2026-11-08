// Тесты разбора ссылок и подписок. Все данные выдуманные.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseLink, parseSubscription, toLink, parseSubscriptionInfo, b64encode } from './links'
import type { ParsedProfile } from './types'

const UUID = 'bf000d23-0752-40b4-affe-68f7707a9661'
const PBK = 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0'
const SS2022_KEY = 'AAECAwQFBgcICQoLDA0ODw==' // 16 байт для 2022-blake3-aes-128-gcm

const vmessJson = {
  v: '2', ps: 'VMess WS', add: 'vm.example.com', port: '443', id: UUID, aid: '0', scy: 'auto',
  net: 'ws', type: 'none', host: 'cdn.example.com', path: '/vm', tls: 'tls', sni: 'cdn.example.com'
}

const LINKS: Record<string, string> = {
  vlessReality: `vless://${UUID}@1.2.3.4:443?type=tcp&security=reality&flow=xtls-rprx-vision&fp=chrome&pbk=${PBK}&sid=0123abcd&sni=www.example.com#%D0%A0%D0%B5%D0%B0%D0%BB%D0%B8%D1%82%D0%B8`,
  vlessWsTls: `vless://${UUID}@ws.example.com:2053?type=ws&security=tls&path=%2Fws%3Fed%3D2048&host=cdn.example.com&sni=cdn.example.com&alpn=h2,http/1.1&allowInsecure=1#ws`,
  vlessGrpc: `vless://${UUID}@grpc.example.com:443?type=grpc&security=tls&serviceName=svc&fp=firefox#grpc`,
  vlessHttp: `vless://${UUID}@h2.example.com:443?type=http&security=tls&host=h2.example.com&path=/h2#h2`,
  vlessHu: `vless://${UUID}@hu.example.com:80?type=httpupgrade&host=hu.example.com&path=/up#hu`,
  vmess: 'vmess://' + b64encode(JSON.stringify(vmessJson)),
  vmessGrpc: 'vmess://' + b64encode(JSON.stringify({ ...vmessJson, ps: 'VMess gRPC', net: 'grpc', path: 'grpcsvc', tls: '' })),
  trojan: 'trojan://secret-pass@tr.example.com:443?sni=tr.example.com&type=grpc&serviceName=tg#trojan',
  ssSip002: `ss://${b64encode('aes-256-gcm:pa55word', true)}@ss.example.com:8388#ss-new`,
  ssOld: 'ss://' + b64encode('chacha20-ietf-poly1305:old:pass@ss-old.example.com:8389') + '#ss-old',
  ss2022: `ss://2022-blake3-aes-128-gcm:${encodeURIComponent(SS2022_KEY)}@ss22.example.com:8390#ss2022`,
  ssObfs: `ss://${b64encode('aes-128-gcm:pw', true)}@obfs.example.com:8391/?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3Dbing.com#obfs`,
  hy2: 'hysteria2://hy-pass@hy.example.com:443/?sni=hy.example.com&obfs=salamander&obfs-password=obfspw&insecure=1#hy2',
  hy2Hop: 'hy2://hy-pass@hy.example.com:443?mport=20000-30000,40000&hop_interval=15#hop',
  hysteria: 'hysteria://h1.example.com:443?protocol=udp&auth=a1&peer=h1.example.com&upmbps=20&downmbps=100&obfsParam=xx#h1',
  tuic: `tuic://${UUID}:tuic-pass@tuic.example.com:443?congestion_control=bbr&udp_relay_mode=native&alpn=h3&sni=tuic.example.com#tuic`,
  socks: 'socks://' + b64encode('user:pass') + '@5.6.7.8:1080#socks-b64',
  socks5: 'socks5://user:p%40ss@5.6.7.8:1081#s5',
  socks4: 'socks4://5.6.7.8:1082',
  http: 'http://user:pass@9.9.9.9:8080#http',
  https: 'https://user:pass@secure.example.com:443?sni=secure.example.com#https',
  anytls: 'anytls://any-pass@any.example.com:443?sni=any.example.com#anytls',
  ipv6: `vless://${UUID}@[2001:db8::1]:443?security=tls&sni=v6.example.com#v6`
}

describe('parseLink', () => {
  it('разбирает все поддерживаемые ссылки', () => {
    for (const [k, l] of Object.entries(LINKS)) {
      expect(parseLink(l), k).not.toBeNull()
    }
  })

  it('vless reality', () => {
    const p = parseLink(LINKS.vlessReality)!
    expect(p.name).toBe('Реалити')
    expect(p.outbound).toEqual({
      type: 'vless', server: '1.2.3.4', server_port: 443, uuid: UUID, flow: 'xtls-rprx-vision',
      tls: {
        enabled: true, server_name: 'www.example.com',
        utls: { enabled: true, fingerprint: 'chrome' },
        reality: { enabled: true, public_key: PBK, short_id: '0123abcd' }
      }
    })
  })

  it('vless ws с early data и alpn', () => {
    const o = parseLink(LINKS.vlessWsTls)!.outbound as any
    expect(o.transport).toEqual({
      type: 'ws', path: '/ws', headers: { Host: 'cdn.example.com' },
      max_early_data: 2048, early_data_header_name: 'Sec-WebSocket-Protocol'
    })
    expect(o.tls.alpn).toEqual(['h2', 'http/1.1'])
    expect(o.tls.insecure).toBe(true)
  })

  it('vless grpc/http/httpupgrade', () => {
    expect((parseLink(LINKS.vlessGrpc)!.outbound as any).transport).toEqual({ type: 'grpc', service_name: 'svc' })
    expect((parseLink(LINKS.vlessHttp)!.outbound as any).transport).toEqual({ type: 'http', host: ['h2.example.com'], path: '/h2' })
    const hu = parseLink(LINKS.vlessHu)!.outbound as any
    expect(hu.transport).toEqual({ type: 'httpupgrade', host: 'hu.example.com', path: '/up' })
    expect(hu.tls).toBeUndefined()
  })

  it('vmess v2rayN', () => {
    const p = parseLink(LINKS.vmess)!
    expect(p.name).toBe('VMess WS')
    expect(p.outbound).toMatchObject({ type: 'vmess', server: 'vm.example.com', server_port: 443, uuid: UUID, security: 'auto', alter_id: 0 })
    expect((p.outbound as any).tls.server_name).toBe('cdn.example.com')
    expect((parseLink(LINKS.vmessGrpc)!.outbound as any).transport).toEqual({ type: 'grpc', service_name: 'grpcsvc' })
  })

  it('trojan: tls по умолчанию', () => {
    const o = parseLink(LINKS.trojan)!.outbound as any
    expect(o.password).toBe('secret-pass')
    expect(o.tls).toEqual({ enabled: true, server_name: 'tr.example.com' })
  })

  it('shadowsocks во всех форматах', () => {
    expect(parseLink(LINKS.ssSip002)!.outbound).toEqual({ type: 'shadowsocks', server: 'ss.example.com', server_port: 8388, method: 'aes-256-gcm', password: 'pa55word' })
    const old = parseLink(LINKS.ssOld)!
    expect(old.name).toBe('ss-old')
    expect(old.outbound).toMatchObject({ method: 'chacha20-ietf-poly1305', password: 'old:pass', server: 'ss-old.example.com', server_port: 8389 })
    expect((parseLink(LINKS.ss2022)!.outbound as any).password).toBe(SS2022_KEY)
    expect(parseLink(LINKS.ssObfs)!.outbound).toMatchObject({ plugin: 'obfs-local', plugin_opts: 'obfs=http;obfs-host=bing.com' })
  })

  it('hysteria2 с obfs и порт-хоппингом', () => {
    expect(parseLink(LINKS.hy2)!.outbound).toEqual({
      type: 'hysteria2', server: 'hy.example.com', server_port: 443, password: 'hy-pass',
      obfs: { type: 'salamander', password: 'obfspw' },
      tls: { enabled: true, server_name: 'hy.example.com', insecure: true }
    })
    expect(parseLink(LINKS.hy2Hop)!.outbound).toMatchObject({ server_ports: ['20000:30000', '40000:40000'], hop_interval: '15s' })
    const inHost = parseLink('hy2://pw@h.example.com:443,5000-6000#x')!.outbound
    expect(inHost).toMatchObject({ server_port: 443, server_ports: ['443:443', '5000:6000'] })
  })

  it('socks / http / https', () => {
    expect(parseLink(LINKS.socks)!.outbound).toMatchObject({ type: 'socks', version: '5', username: 'user', password: 'pass' })
    expect(parseLink(LINKS.socks5)!.outbound).toMatchObject({ password: 'p@ss' })
    expect(parseLink(LINKS.socks4)!).toEqual({ name: '5.6.7.8:1082', outbound: { type: 'socks', server: '5.6.7.8', server_port: 1082, version: '4' } })
    expect((parseLink(LINKS.http)!.outbound as any).tls).toBeUndefined()
    expect((parseLink(LINKS.https)!.outbound as any).tls).toEqual({ enabled: true, server_name: 'secure.example.com' })
    // ссылка на сайт/подписку — не прокси
    expect(parseLink('https://sub.example.com/api/v1/sub?token=abc')).toBeNull()
  })

  it('ipv6, мусор и неподдерживаемое', () => {
    expect(parseLink(LINKS.ipv6)!.outbound).toMatchObject({ server: '2001:db8::1' })
    expect(parseLink('wireguard://key@1.2.3.4:51820?publickey=x')).toBeNull()
    expect(parseLink('wg://key@1.2.3.4:51820')).toBeNull()
    expect(parseLink(`vless://${UUID}@x.example.com:443?type=xhttp&security=tls`)).toBeNull()
    expect(parseLink('vless://nohost')).toBeNull()
    expect(parseLink('просто текст')).toBeNull()
    expect(parseLink('vmess://!!!')).toBeNull()
  })
})

describe('parseSubscription', () => {
  const lines = [LINKS.vlessReality, LINKS.trojan, LINKS.hy2, 'мусорная строка', LINKS.ssSip002]

  it('построчный список', () => {
    expect(parseSubscription(lines.join('\r\n'))).toHaveLength(4)
  })

  it('base64, urlsafe и без паддинга', () => {
    const text = lines.join('\n')
    expect(parseSubscription(b64encode(text))).toHaveLength(4)
    expect(parseSubscription(b64encode(text, true))).toHaveLength(4)
    // с переносами строк внутри base64
    expect(parseSubscription(b64encode(text).replace(/(.{60})/g, '$1\n'))).toHaveLength(4)
  })

  it('sing-box JSON', () => {
    const json = JSON.stringify({
      outbounds: [
        { type: 'selector', tag: 'proxy', outbounds: ['a'] },
        { type: 'vless', tag: 'Нидерланды', server: 'nl.example.com', server_port: 443, uuid: UUID, detour: 'x' },
        { type: 'direct', tag: 'direct' },
        { type: 'dns', tag: 'dns-out' },
        { type: 'block', tag: 'block' },
        { type: 'urltest', tag: 'auto', outbounds: ['a'] },
        { type: 'shadowsocks', tag: 'ss', server: 's.example.com', server_port: 1, method: 'aes-128-gcm', password: 'x' }
      ]
    })
    const r = parseSubscription(json)
    expect(r.map((p) => p.name)).toEqual(['Нидерланды', 'ss'])
    expect(r[0].outbound).toEqual({ type: 'vless', server: 'nl.example.com', server_port: 443, uuid: UUID })
  })

  it('Clash YAML', () => {
    const yaml = `
port: 7890
proxies:
  - { name: "ss1", type: ss, server: ss.example.com, port: 8388, cipher: aes-256-gcm, password: pw }
  - name: ss-obfs
    type: ss
    server: ss.example.com
    port: 8389
    cipher: aes-128-gcm
    password: pw
    plugin: obfs
    plugin-opts: { mode: tls, host: bing.com }
  - name: vmess-ws
    type: vmess
    server: vm.example.com
    port: 443
    uuid: ${UUID}
    alterId: 0
    cipher: auto
    tls: true
    servername: cdn.example.com
    network: ws
    ws-opts: { path: /vm, headers: { Host: cdn.example.com } }
  - name: vless-reality
    type: vless
    server: 1.2.3.4
    port: 443
    uuid: ${UUID}
    flow: xtls-rprx-vision
    tls: true
    servername: www.example.com
    client-fingerprint: chrome
    reality-opts: { public-key: ${PBK}, short-id: 0123abcd }
  - name: trojan-grpc
    type: trojan
    server: tr.example.com
    port: 443
    password: pw
    sni: tr.example.com
    network: grpc
    grpc-opts: { grpc-service-name: svc }
  - { name: hy2, type: hysteria2, server: hy.example.com, port: 443, password: pw, obfs: salamander, obfs-password: o, ports: 20000-30000, up: "50 Mbps", down: 200 }
  - { name: tuic, type: tuic, server: tuic.example.com, port: 443, uuid: ${UUID}, password: pw, alpn: [h3], congestion-controller: bbr, udp-relay-mode: native }
  - { name: s5, type: socks5, server: 5.6.7.8, port: 1080, username: u, password: p }
  - { name: web, type: http, server: 9.9.9.9, port: 8080, tls: true, sni: web.example.com }
  - { name: snell, type: snell, server: x.example.com, port: 1, psk: x }
proxy-groups: []
`
    const r = parseSubscription(yaml)
    expect(r.map((p) => p.name)).toEqual(['ss1', 'ss-obfs', 'vmess-ws', 'vless-reality', 'trojan-grpc', 'hy2', 'tuic', 's5', 'web'])
    const byName = Object.fromEntries(r.map((p) => [p.name, p.outbound as any]))
    expect(byName['ss-obfs'].plugin_opts).toBe('obfs=tls;obfs-host=bing.com')
    expect(byName['vmess-ws'].transport).toEqual({ type: 'ws', path: '/vm', headers: { Host: 'cdn.example.com' } })
    expect(byName['vless-reality'].tls.reality).toEqual({ enabled: true, public_key: PBK, short_id: '0123abcd' })
    expect(byName['hy2']).toMatchObject({ server_ports: ['20000:30000'], up_mbps: 50, down_mbps: 200 })
    expect(byName['s5']).toEqual({ type: 'socks', server: '5.6.7.8', server_port: 1080, version: '5', username: 'u', password: 'p' })
  })

  it('пустое и мусор', () => {
    expect(parseSubscription('')).toEqual([])
    expect(parseSubscription('hello world')).toEqual([])
  })
})

describe('toLink → parseLink', () => {
  it('roundtrip для всех поддерживаемых типов', () => {
    let n = 0
    for (const [k, l] of Object.entries(LINKS)) {
      const p = parseLink(l)!
      const link = toLink(p)
      if (link === null) {
        expect(p.outbound.type, k).toBe('hysteria') // hysteria v1 наружу не отдаём
        continue
      }
      expect(parseLink(link), `${k}: ${link}`).toEqual(p)
      n++
    }
    expect(n).toBeGreaterThanOrEqual(20)
  })
})

describe('parseSubscriptionInfo', () => {
  it('разбирает заголовок', () => {
    expect(parseSubscriptionInfo('upload=455727941; download=6174315083; total=1073741824000; expire=1671815872')).toEqual({
      upload: 455727941, download: 6174315083, total: 1073741824000, expire: 1671815872
    })
    expect(parseSubscriptionInfo('upload=1;download=2')).toEqual({ upload: 1, download: 2, total: 0, expire: 0 })
    expect(parseSubscriptionInfo(null)).toBeNull()
    expect(parseSubscriptionInfo('garbage')).toBeNull()
  })
})

// ---------- проверка самим ядром ----------

const SING_BOX = resolve(__dirname, '../../resources/core/sing-box.exe')

/** Гоняет `sing-box check` по конфигу со всеми outbound'ами. Возвращает вывод ошибки или ''. */
function coreCheck(profiles: ParsedProfile[]): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orbita-check-'))
  const file = join(dir, 'config.json')
  const config = {
    log: { level: 'error' },
    inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: 0 }],
    outbounds: profiles.map((p, i) => ({ ...p.outbound, tag: `p${i}` }))
  }
  writeFileSync(file, JSON.stringify(config))
  try {
    const r = spawnSync(SING_BOX, ['check', '-c', file], { encoding: 'utf8' })
    return { code: r.status, out: (r.stdout + r.stderr).trim() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!existsSync(SING_BOX))('sing-box check', () => {
  it('все ссылки проходят проверку ядром', () => {
    const profiles = Object.values(LINKS).map((l) => parseLink(l)!)
    const r = coreCheck(profiles)
    expect(r.out).toBe('')
    expect(r.code).toBe(0)
  })

  it('профили из Clash и sing-box подписок тоже', () => {
    const clash = `proxies:
  - { name: a, type: vless, server: 1.2.3.4, port: 443, uuid: ${UUID}, tls: true, network: grpc, grpc-opts: { grpc-service-name: s } }
  - { name: b, type: hysteria2, server: h.example.com, port: 443, password: p, ports: 20000-30000 }
  - { name: c, type: ss, server: s.example.com, port: 1, cipher: aes-128-gcm, password: p, plugin: v2ray-plugin, plugin-opts: { mode: websocket, tls: true, host: a.com, path: /x } }
`
    const profiles = [...parseSubscription(clash), parseLink(LINKS.vlessReality)!]
    expect(profiles).toHaveLength(4)
    const r = coreCheck(profiles)
    expect(r.out).toBe('')
    expect(r.code).toBe(0)
  })

  it('ядро действительно ловит ошибки (контроль)', () => {
    const r = coreCheck([{ name: 'bad', outbound: { type: 'vless', server: 'x', server_port: 1, uuid: UUID, transport: { type: 'xhttp' } } }])
    expect(r.code).not.toBe(0)
  })
})
