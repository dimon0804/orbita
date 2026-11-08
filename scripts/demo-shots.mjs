// Скриншоты для README на выдуманных серверах.
import { _electron as electron } from 'playwright'
import { rmSync } from 'fs'
const data = process.env.ORBITA_DATA
rmSync(data, { recursive: true, force: true })
const app = await electron.launch({ args: ['.', '--no-elevate'], env: { ...process.env, ORBITA_DATA: data } })
const win = await app.firstWindow()
await win.setViewportSize({ width: 1180, height: 760 })
await win.waitForSelector('.dash')
const call = (ch, ...a) => win.evaluate(([ch, a]) => window.orbita.call(ch, ...a), [ch, a])
const links = [
  'vless://11111111-2222-3333-4444-555555555555@de1.example.com:443?security=reality&sni=www.microsoft.com&fp=chrome&pbk=Zm9vYmFyYmF6cXV4ZXhhbXBsZWtleWZvcmRlbW8wMTI&sid=ab&flow=xtls-rprx-vision&type=tcp#🇩🇪 Германия · Франкфурт',
  'hy2://pass@nl1.example.com:443?sni=nl1.example.com#🇳🇱 Нидерланды · Амстердам',
  'trojan://pass@fi1.example.com:443?sni=fi1.example.com#🇫🇮 Финляндия · Хельсинки',
  'vless://11111111-2222-3333-4444-555555555555@us1.example.com:443?security=tls&sni=us1.example.com&type=ws&path=%2Fws#🇺🇸 США · Нью-Йорк',
  'ss://YWVzLTI1Ni1nY206cGFzcw@tr1.example.com:8388#🇹🇷 Турция · Стамбул',
  'socks5://user:pass@10.0.0.5:1080#🇰🇿 Казахстан · SOCKS5',
  'https://user:pass@proxy.example.com:8443#🇵🇱 Польша · HTTPS',
  'tuic://11111111-2222-3333-4444-555555555555:pass@jp1.example.com:443?sni=jp1.example.com&congestion_control=bbr#🇯🇵 Япония · Токио'
]
await call('add:text', links.join('\n'))
const st = await call('state')
const lat = [48, 61, 74, 132, 96, 210, 88, 245]
await win.evaluate((lat) => {}, lat)
for (const [i, p] of st.profiles.entries()) await call('profile:update', p.id, { latency: lat[i], traffic: { up: 1e8 * (8 - i), down: 9e8 * (8 - i) } })
await call('select', st.profiles[0].id)
await win.click('.nav:has-text("Серверы")'); await win.waitForTimeout(700)
await win.screenshot({ path: 'docs/servers.png' })
await win.click('.nav:has-text("Маршруты")'); await win.waitForTimeout(500)
await win.screenshot({ path: 'docs/rules.png' })
await win.click('.nav:has-text("Главная")'); await win.waitForTimeout(1500)
await win.evaluate(() => { const t = document.querySelector('.ip-tile'); if (t) { t.querySelector('.tile-value').textContent = '🇩🇪 203.0.113.42'; t.querySelector('.tile-sub').textContent = 'Frankfurt, Germany · Example Hosting' } })
await win.screenshot({ path: 'docs/home.png' })
await app.close()
