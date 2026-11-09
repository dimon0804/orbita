// Kill switch в режиме «Системный»: роняем ядро — прокси должен остаться, «Отключить» — снять.
// Значения прокси в реестре сохраняются до прогона и возвращаются после.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

const KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
const q = (v) => {
  try {
    return execFileSync('reg', ['query', KEY, '/v', v]).toString().trim().split(/\s+/).pop()
  } catch {
    return undefined
  }
}
const before = { enable: q('ProxyEnable'), server: q('ProxyServer'), override: q('ProxyOverride') }
const data = join(process.cwd(), '.e2e-data', 'xhttp')
const app = await electron.launch({ args: ['.', '--no-elevate'], env: { ...process.env, ORBITA_DATA: data } })
const win = await app.firstWindow()
await win.waitForSelector('.dash')
const call = (ch, ...a) => win.evaluate(([ch, a]) => window.orbita.call(ch, ...a), [ch, a])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = false
const check = (ok, msg) => {
  console.log(ok ? 'OK  ' : 'FAIL', msg)
  if (!ok) failed = true
}
try {
  let st = await call('state')
  if (!st.profiles.length) throw new Error('сначала прогони e2e-xhttp.mjs — нужна подписка в .e2e-data/xhttp')
  await call('settings', { mixedPort: 2188, killSwitch: true, autoReconnect: false })
  const plain = st.profiles.find((p) => p.outbound.type === 'vless' && typeof p.latency === 'number')
  await call('select', plain.id)
  await call('mode', 'system')
  await call('connect')
  check(q('ProxyEnable') === '0x1' && q('ProxyServer')?.includes('2188'), `прокси включён: ${q('ProxyServer')}`)

  const pid = JSON.parse(readFileSync(join(data, 'data', 'orbita.json'), 'utf8')).corePid
  execFileSync('taskkill', ['/PID', String(pid), '/F'])
  await sleep(1500)
  st = await call('state')
  check(st.status.state === 'error', `ядро упало: ${st.status.state}`)
  check(q('ProxyEnable') === '0x1', 'kill switch оставил прокси на мёртвом порту')
  check(st.killSwitchActive === true, 'в окне видно, что kill switch держит')

  await call('disconnect')
  await sleep(500)
  st = await call('state')
  check(q('ProxyEnable') === '0x0', '«Отключить» снял прокси')
  check(!st.killSwitchActive, 'и флаг kill switch')

  // Без kill switch — снимается сразу при падении
  await call('settings', { killSwitch: false })
  await call('connect')
  const pid2 = JSON.parse(readFileSync(join(data, 'data', 'orbita.json'), 'utf8')).corePid
  execFileSync('taskkill', ['/PID', String(pid2), '/F'])
  await sleep(1500)
  check(q('ProxyEnable') === '0x0', 'без kill switch прокси снят сразу после падения')

  // Тест скорости: обычный VLESS и xhttp
  for (const p of [plain, st.profiles.find((x) => x.outbound.type === 'xray' && typeof x.latency === 'number')]) {
    if (!p) continue
    const t = Date.now()
    try {
      const mbps = await call('speedtest', p.id)
      check(mbps > 0, `скорость ${p.outbound.type}: ${mbps} Мбит/с за ${((Date.now() - t) / 1000).toFixed(1)} с`)
    } catch (e) {
      check(false, `скорость ${p.outbound.type}: ${e.message}`)
    }
  }
} finally {
  await call('disconnect').catch(() => {})
  await call('mode', 'proxy').catch(() => {})
  await app.close()
  if (before.enable) execFileSync('reg', ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', String(parseInt(before.enable, 16)), '/f'])
  if (before.server) execFileSync('reg', ['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', before.server, '/f'])
  if (before.override) execFileSync('reg', ['add', KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', before.override, '/f'])
  console.log('реестр возвращён:', q('ProxyEnable'), q('ProxyServer'))
}
process.exit(failed ? 1 : 0)
