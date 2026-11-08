// Живой прогон: запускает собранное приложение в отдельной папке данных,
// импортирует NekoBox, меряет задержку, подключается в режиме «только порт», снимает скриншоты.
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { execSync, spawn } from 'child_process'

const data = process.env.ORBITA_DATA || join(process.cwd(), '.e2e-data')
const shots = join(process.cwd(), '.e2e-shots')
mkdirSync(shots, { recursive: true })
const app = await electron.launch({ args: ['.'], env: { ...process.env, ORBITA_DATA: data } })
const win = await app.firstWindow()
win.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text()))
win.on('pageerror', (e) => console.log('page error:', e.message))
await win.setViewportSize({ width: 1180, height: 760 })
await win.waitForSelector('.dash')
const call = (ch, ...a) => win.evaluate(([ch, a]) => window.orbita.call(ch, ...a), [ch, a])
const shot = async (n) => { await win.waitForTimeout(500); await win.screenshot({ path: join(shots, n + '.png') }) }
const nav = async (label) => { await win.click(`.nav:has-text("${label}")`); await win.waitForTimeout(300) }

await shot('01-home-empty')
const st0 = await call('state')
if (!st0.profiles.length) console.log('import:', JSON.stringify(await call('neko:import')))
let st = await call('state')
console.log('groups:', st.groups.map((g) => `${g.kind}:${st.profiles.filter((p) => p.groupId === g.id).length}`).join(' '))

// Задержка по всем
const t0 = Date.now()
await call('latency', st.profiles.map((p) => p.id))
st = await call('state')
const ok = st.profiles.filter((p) => typeof p.latency === 'number')
console.log(`latency: ${ok.length}/${st.profiles.length} ответили за ${Date.now() - t0} мс, лучшая ${Math.min(...ok.map((p) => p.latency))} мс`)

await nav('Серверы'); await shot('02-servers')

// Выбираем самый быстрый и подключаемся в режиме «только порт»
const best = ok.sort((a, b) => a.latency - b.latency)[0]
await call('mode', 'proxy')
await call('select', best.id)
await call('connect')
st = await call('state')
console.log('status:', st.status.state, st.status.mode)
const ip = execSync(`curl -s -m 15 -x socks5h://127.0.0.1:${st.settings.mixedPort} https://ipwho.is/`).toString()
const j = JSON.parse(ip)
console.log('exit via core:', j.country_code, j.connection?.isp)
const direct = JSON.parse(execSync('curl -s -m 15 https://ipwho.is/').toString())
console.log('ip in app:', (await call('ip')).country_code)
console.log('exit without core:', direct.country_code, direct.connection?.isp)
// грузим что-нибудь, чтобы было на графике
try { execSync(`curl -s -m 20 -o NUL -x http://127.0.0.1:${st.settings.mixedPort} https://speed.cloudflare.com/__down?bytes=30000000`) } catch {}
await nav('Главная'); await win.waitForTimeout(2500); await shot('03-home-connected')

// Переключение сервера в той же группе без перезапуска
const second = ok.find((p) => p.groupId === best.groupId && p.id !== best.id)
if (second) {
  await call('select', second.id)
  const px = await win.evaluate(() => 0)
  st = await call('state')
  console.log('switched to second, status:', st.status.state, st.status.profileId === second.id)
}

// Параллельно открываем соединение, чтобы увидеть его в таблице
const bg = spawn('curl', ['-s', '-m', '12', '--limit-rate', '2M', '-o', 'NUL', '-x', `http://127.0.0.1:${st.settings.mixedPort}`, 'https://speed.cloudflare.com/__down?bytes=50000000'])
await nav('Соединения'); await win.waitForTimeout(2500); await shot('04-connections')
console.log('connections rows:', await win.locator('.tbody .tr').count())
await nav('Главная'); await win.waitForTimeout(2000); await shot('03b-home-traffic')
await nav('Логи'); await shot('05-logs')
await nav('Статистика'); await shot('06-stats')
await nav('Маршруты'); await shot('07-rules')
await nav('Настройки'); await shot('08-settings')

// Смена маршрутизации на лету перезапускает ядро
await call('settings', { routeMode: 'global' })
st = await call('state')
console.log('after route change:', st.status.state)
await call('settings', { routeMode: 'rule' })

// Ссылка профиля
console.log('share link scheme:', (await call('profile:link', best.id)).split('://')[0])

await call('disconnect')
st = await call('state')
console.log('after disconnect:', st.status.state)
let portClosed = false
try { execSync(`curl -s -m 3 -x socks5h://127.0.0.1:${st.settings.mixedPort} https://example.com`) } catch { portClosed = true }
console.log('port closed after disconnect:', portClosed)

// Светлая тема
await call('settings', { theme: 'light' }); await nav('Главная'); await shot('09-home-light')
await call('settings', { theme: 'dark' })
await app.close()
