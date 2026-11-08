// Проверка обновления подписки (групп с url) на уже импортированных данных.
import { _electron as electron } from 'playwright'
const app = await electron.launch({ args: ['.', '--no-elevate'], env: { ...process.env } })
const win = await app.firstWindow()
await win.waitForSelector('.dash')
const call = (ch, ...a) => win.evaluate(([ch, a]) => window.orbita.call(ch, ...a), [ch, a])
const st = await call('state')
for (const g of st.groups.filter((g) => g.kind === 'subscription')) {
  try {
    const n = await call('group:refresh', g.id)
    const s2 = await call('state')
    const g2 = s2.groups.find((x) => x.id === g.id)
    console.log('refresh ok, servers:', n, 'info:', !!g2.info, 'expire set:', !!g2.info?.expire)
  } catch (e) { console.log('refresh failed:', e.message.slice(0, 200)) }
}
await app.close()
