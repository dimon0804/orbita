// Режим «Системный прокси»: включает, проверяет реестр, отключает, проверяет, что снято.
import { _electron as electron } from 'playwright'
import { execFileSync, execSync } from 'child_process'
const KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
const q = (v) => execFileSync('reg', ['query', KEY, '/v', v]).toString().trim().split(/\s+/).pop()
const app = await electron.launch({ args: ['.', '--no-elevate'], env: { ...process.env } })
const win = await app.firstWindow()
await win.waitForSelector('.dash')
const call = (ch, ...a) => win.evaluate(([ch, a]) => window.orbita.call(ch, ...a), [ch, a])
try {
  await call('mode', 'system')
  await call('connect')
  console.log('on:', q('ProxyEnable'), q('ProxyServer'))
  const r = execSync('powershell -NoProfile -Command "(Invoke-WebRequest -UseBasicParsing https://ipwho.is/ -TimeoutSec 15).Content"').toString()
  console.log('winhttp-ish request country:', JSON.parse(r).country_code)
} finally {
  await call('disconnect').catch(() => {})
  await call('mode', 'proxy')
  console.log('off:', q('ProxyEnable'), q('ProxyServer'))
  await app.close()
}
