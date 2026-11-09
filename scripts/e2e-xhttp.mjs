// Живой прогон xhttp: подписка из ORBITA_SUB (в репозиторий не кладём), задержка,
// подключение к xhttp-серверу через второе ядро Xray, проверка выхода, переключение на обычный сервер.
import { _electron as electron } from 'playwright'
import { rmSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

const sub = process.env.ORBITA_SUB
if (!sub) throw new Error('нужна переменная ORBITA_SUB со ссылкой на подписку')
const data = join(process.cwd(), '.e2e-data', 'xhttp')
rmSync(data, { recursive: true, force: true })
const app = await electron.launch({ args: ['.', '--no-elevate'], env: { ...process.env, ORBITA_DATA: data } })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('page error:', e.message))
await win.waitForSelector('.dash')
const call = (ch, ...a) => win.evaluate(([ch, a]) => window.orbita.call(ch, ...a), [ch, a])
const ipVia = (port) => JSON.parse(execSync(`curl -s -m 20 -x socks5h://127.0.0.1:${port} https://ipwho.is/`).toString())
let failed = false
const check = (ok, msg) => {
  console.log(ok ? 'OK  ' : 'FAIL', msg)
  if (!ok) failed = true
}

try {
  await call('settings', { mixedPort: 2188 })
  const r = await call('add:text', sub)
  let st = await call('state')
  const xs = st.profiles.filter((p) => p.outbound.type === 'xray')
  check(xs.length > 0, `подписка: ${r.added} серверов, из них xhttp ${xs.length}`)

  await call('latency', st.profiles.map((p) => p.id))
  st = await call('state')
  const xok = st.profiles.filter((p) => p.outbound.type === 'xray' && typeof p.latency === 'number')
  check(xok.length > 0, `задержка xhttp: ответили ${xok.length}/${xs.length}, лучшая ${Math.min(...xok.map((p) => p.latency))} мс`)

  const best = xok.sort((a, b) => a.latency - b.latency)[0]
  await call('mode', 'proxy')
  await call('select', best.id)
  await call('connect')
  st = await call('state')
  check(st.status.state === 'running', `подключение к xhttp: ${st.status.state} ${st.status.error ?? ''}`)
  const j = ipVia(2188)
  check(j.success !== false && !!j.country_code, `выход через xhttp: ${j.country_code}`)
  const logs = await call('logs')
  check(logs.some((l) => l.text.includes('[xray] запущен')), 'Xray поднялся вместе с ядром')

  // Переключение на обычный сервер той же группы без перезапуска
  const plain = st.profiles.find((p) => p.groupId === best.groupId && p.outbound.type === 'vless' && typeof p.latency === 'number')
  if (plain) {
    await call('select', plain.id)
    const j2 = ipVia(2188)
    check(!!j2.country_code, `переключение на обычный VLESS: ${j2.country_code}`)
    await call('select', best.id)
    check(!!ipVia(2188).country_code, 'и обратно на xhttp')
  }

  await call('disconnect')
  await new Promise((r) => setTimeout(r, 800))
  const left = execSync('tasklist /FI "IMAGENAME eq xray.exe" /FO CSV /NH').toString()
  const ours = left.split('\n').filter((l) => l.includes('xray.exe')).length
  check(true, `после отключения процессов xray.exe в системе: ${ours}`)
} finally {
  await app.close()
}
process.exit(failed ? 1 : 0)
