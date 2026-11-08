// Проверка обновления против настоящего релиза: притворяемся старой версией, качаем установщик (не ставим).
import { _electron as electron } from 'playwright'
import { statSync } from 'fs'
const app = await electron.launch({ args: ['.', '--no-elevate'], env: { ...process.env, ORBITA_FAKE_VERSION: '0.1.0' } })
const win = await app.firstWindow()
await win.waitForSelector('.dash')
const call = (ch, ...a) => win.evaluate(([ch, a]) => window.orbita.call(ch, ...a), [ch, a])
const u = await call('update:check')
console.log('check:', u.current, '→', u.latest, 'available:', u.available, 'setup:', Boolean(u.setupUrl))
await win.waitForSelector('.update-card')
await win.screenshot({ path: '.e2e-shots/15-update-banner.png' })
const t = Date.now()
await win.waitForTimeout(100)
setTimeout(() => void call('update:check').catch(() => {}), 3000) // проверка посреди скачивания
await call('update:download')
const st = await call('state')
console.log('download:', st.update.stage, `${Math.round((Date.now() - t) / 1000)} с`, 'file size ok:', statSync(st.update.file).size === u.setupSize)
await win.screenshot({ path: '.e2e-shots/16-update-ready.png' })
await app.close()
