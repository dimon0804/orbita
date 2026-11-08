// Живой прогон функций 0.2: автовыбор сервера, QR, «О программе», проверка обновлений.
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'fs'
import { join } from 'path'

const shots = join(process.cwd(), '.e2e-shots')
mkdirSync(shots, { recursive: true })
const app = await electron.launch({ args: ['.', '--no-elevate'], env: { ...process.env } })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('page error:', e.message))
await win.setViewportSize({ width: 1180, height: 760 })
await win.waitForSelector('.dash')
const call = (ch, ...a) => win.evaluate(([ch, a]) => window.orbita.call(ch, ...a), [ch, a])
const nav = async (label) => { await win.click(`.nav:has-text("${label}")`); await win.waitForTimeout(400) }

await call('settings', { mixedPort: 2188 })
let st = await call('state')
if (!st.profiles.length) await call('neko:import')
st = await call('state')
console.log('version:', st.version, 'update field:', JSON.stringify(st.update && { latest: st.update.latest, available: st.update.available }))

// Обновления
try {
  const u = await call('update:check')
  console.log('update check:', u.current, '→', u.latest, 'available:', u.available)
} catch (e) { console.log('update check error:', e.message) }

// Авто в самой большой группе
const counts = new Map()
for (const p of st.profiles) counts.set(p.groupId, (counts.get(p.groupId) ?? 0) + 1)
const gid = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
await call('mode', 'proxy')
await call('select', `auto:${gid}`)
await call('connect')
await win.waitForTimeout(6000)
const px = await call('core:proxies')
st = await call('state')
const now = st.profiles.find((p) => p.id === px.auto?.now)
console.log('auto status:', st.status.state, st.status.profileId === `auto:${gid}`, 'auto picked:', now ? 'профиль группы' : px.auto?.now)
await nav('Главная'); await win.waitForTimeout(5500)
await win.screenshot({ path: join(shots, '10-home-auto.png') })

// Ручной выбор внутри группы без перезапуска и обратно в авто
const one = st.profiles.find((p) => p.groupId === gid)
await call('select', one.id)
console.log('manual in auto group:', (await call('state')).status.profileId === one.id)
await call('select', `auto:${gid}`)

await nav('Серверы')
await win.click(`.group-item:nth-child(${[...(await call('state')).groups].findIndex((g) => g.id === gid) + 1})`)
await win.waitForTimeout(300)
await win.screenshot({ path: join(shots, '11-servers-auto.png') })
await win.hover('.plist .prow:nth-child(2)')
await win.click('.plist .prow:nth-child(2) [title="QR-код для телефона"]')
await win.waitForSelector('.qr-box img')
await win.screenshot({ path: join(shots, '12-qr.png') })
await win.keyboard.press('Escape')

await nav('О программе'); await win.screenshot({ path: join(shots, '13-about.png') })
await nav('Настройки'); await win.mouse.wheel(0, 400); await win.waitForTimeout(300); await win.screenshot({ path: join(shots, '14-settings.png') })

await call('disconnect')
console.log('after disconnect:', (await call('state')).status.state)
await app.close()
