// Собранные конфиги прогоняются через настоящие ядра: sing-box check и xray -test.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseLink, parseSubscription, toLink } from '@shared/links'
import { buildXrayConfig, isXray, XrayOutbound } from '@shared/xray'
import type { Profile, Settings } from '@shared/types'
import { buildConfig, buildTestConfig } from './configBuilder'

const CORE = resolve(__dirname, '../../resources/core')
const SING_BOX = join(CORE, 'sing-box.exe')
const XRAY = join(CORE, 'xray.exe')

const UUID = 'bf000d23-0752-40b4-affe-68f7707a9661'
const PBK = 'jNXHt1yRo0vDuchQlIP6Z0ZvjT3KtzVI-T4E7RoLJS0'
const WG_PRIV = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk='
const WG_PUB = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg='

const XHTTP_REALITY = `vless://${UUID}@1.2.3.4:443?type=xhttp&security=reality&pbk=${PBK}&sid=0123abcd&sni=www.example.com&fp=firefox&path=%2Fx&mode=auto#xhttp-reality`
const XHTTP_TLS = `vless://${UUID}@x.example.com:443?type=xhttp&security=tls&sni=x.example.com&alpn=h2&host=x.example.com&path=%2Fup&mode=packet-up&extra=%7B%22xPaddingBytes%22%3A%22100-1000%22%7D#xhttp-tls`
const TROJAN_XHTTP = `trojan://pw@t.example.com:443?type=splithttp&security=tls&sni=t.example.com#tr-xhttp`
const WG_LINK = `wireguard://${encodeURIComponent(WG_PRIV)}@162.159.192.1:2408?publickey=${encodeURIComponent(WG_PUB)}&address=172.16.0.2,2606:4700::2&mtu=1280&reserved=1,2,3#warp`
const WG_CONF = `[Interface]
PrivateKey = ${WG_PRIV}
Address = 10.8.0.2/24
DNS = 1.1.1.1
MTU = 1420

[Peer]
PublicKey = ${WG_PUB}
PresharedKey = ${WG_PUB}
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.com:51820
PersistentKeepalive = 25
`

const settings = {
  connectMode: 'tun', routeMode: 'rule', mixedPort: 2088, allowLan: false, clashPort: 9097, tunStack: 'mixed',
  tunMtu: 9000, tunStrictRoute: false, ipv6: false, dnsRemote: 'https://1.1.1.1/dns-query',
  dnsDirect: 'https://77.88.8.8/dns-query', bypassRu: false, blockAds: false, rules: [],
  testUrl: 'https://www.gstatic.com/generate_204', logLevel: 'info'
} as unknown as Settings

function prof(id: string, link: string): Profile {
  const p = parseLink(link)
  if (!p) throw new Error('не разобралась ссылка ' + id)
  return { ...p, id, groupId: 'g', createdAt: 0 }
}

function run(bin: string, args: (f: string) => string[], cfg: unknown): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orbita-cfg-'))
  const f = join(dir, 'c.json')
  writeFileSync(f, JSON.stringify(cfg))
  try {
    const r = spawnSync(bin, args(f), { encoding: 'utf8' })
    return { code: r.status, out: (r.stdout + r.stderr).trim() }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('разбор xhttp и WireGuard', () => {
  it('xhttp идёт в Xray и обратно в ссылку без потерь', () => {
    for (const l of [XHTTP_REALITY, XHTTP_TLS, TROJAN_XHTTP]) {
      const p = parseLink(l)!
      expect(p.outbound.type).toBe('xray')
      const again = parseLink(toLink(p)!)!
      expect(again).toEqual(p)
    }
  })

  it('WireGuard: ссылка и .conf', () => {
    const w = parseLink(WG_LINK)!.outbound
    expect(w).toMatchObject({ type: 'wireguard', server: '162.159.192.1', server_port: 2408, mtu: 1280, reserved: [1, 2, 3] })
    expect(w.local_address).toEqual(['172.16.0.2/32', '2606:4700::2/128'])
    const c = parseSubscription(WG_CONF)
    expect(c).toHaveLength(1)
    expect(c[0].outbound).toMatchObject({ server: 'vpn.example.com', server_port: 51820, local_address: ['10.8.0.2/24'], mtu: 1420 })
    expect(parseLink(toLink(parseLink(WG_LINK)!)!)).toEqual(parseLink(WG_LINK))
  })
})

describe.skipIf(!existsSync(SING_BOX))('sing-box check собранного конфига', () => {
  const profiles = [
    prof('a', XHTTP_REALITY),
    prof('b', WG_LINK),
    { ...parseSubscription(WG_CONF)[0], id: 'c', groupId: 'g', createdAt: 0 },
    prof('d', `vless://${UUID}@1.2.3.4:443?type=tcp&security=reality&flow=xtls-rprx-vision&pbk=${PBK}&sid=01&sni=a.com#r`)
  ]

  it('TUN-конфиг с xhttp, WireGuard и обычным VLESS', () => {
    const cfg = buildConfig({
      settings, profiles, selected: 'a', mode: 'tun', rulesDir: '.', dataDir: tmpdir(),
      clashSecret: 's', clashPort: 9999, xrayPorts: { a: 20001 }
    }) as Record<string, any>
    expect(cfg.endpoints).toHaveLength(2)
    expect(cfg.route.rules[1]).toEqual({ process_name: ['xray.exe'], outbound: 'direct' })
    const r = run(SING_BOX, (f) => ['check', '-c', f], cfg)
    expect(r.out).toBe('')
    expect(r.code).toBe(0)
  })

  it('xhttp без запущенного Xray выпадает из конфига', () => {
    const cfg = buildConfig({
      settings, profiles, selected: 'd', mode: 'system', rulesDir: '.', dataDir: tmpdir(), clashSecret: 's', clashPort: 9999
    }) as Record<string, any>
    expect(cfg.outbounds.find((o: any) => o.tag === 'a')).toBeUndefined()
    expect(run(SING_BOX, (f) => ['check', '-c', f], cfg).code).toBe(0)
  })

  it('конфиг теста скорости', () => {
    const cfg = buildTestConfig(profiles, 9999, 's', { a: 20001 }, { listenPort: 20002, profileId: 'b' })
    const r = run(SING_BOX, (f) => ['check', '-c', f], cfg)
    expect(r.out).toBe('')
  })
})

describe.skipIf(!existsSync(XRAY))('xray -test', () => {
  it('reality, tls с extra и trojan через splithttp', () => {
    const items = [XHTTP_REALITY, XHTTP_TLS, TROJAN_XHTTP].map((l, i) => {
      const o = parseLink(l)!.outbound
      expect(isXray(o)).toBe(true)
      return { id: String(i), outbound: o as XrayOutbound, port: 21000 + i }
    })
    const r = run(XRAY, (f) => ['run', '-test', '-c', f], buildXrayConfig(items))
    expect(r.out).toMatch(/Configuration OK/)
    expect(r.code).toBe(0)
  })
})
