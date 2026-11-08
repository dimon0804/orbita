import { app } from 'electron'
import { spawn } from 'child_process'
import { createWriteStream, existsSync, statSync } from 'fs'
import { join } from 'path'

// Проверка обновлений через релизы GitHub и установка новой версии.

export const REPO = 'dimon0804/orbita'
export const REPO_URL = `https://github.com/${REPO}`

export interface UpdateInfo {
  current: string
  latest: string
  available: boolean
  notes: string
  url: string
  publishedAt?: string
  setupUrl?: string
  setupSize?: number
  portableUrl?: string
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** «1.10.0» > «1.9.3»; хвосты вида «-beta.1» считаем младше чистой версии. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): [number[], string] => {
    const [main, pre = ''] = v.replace(/^v/, '').split('-', 2)
    return [main.split('.').map((x) => Number(x) || 0), pre]
  }
  const [am, ap] = parse(a)
  const [bm, bp] = parse(b)
  for (let i = 0; i < Math.max(am.length, bm.length); i++) {
    const d = (am[i] ?? 0) - (bm[i] ?? 0)
    if (d) return Math.sign(d)
  }
  if (ap === bp) return 0
  if (!ap) return 1
  if (!bp) return -1
  return ap < bp ? -1 : 1
}

export const currentVersion = (): string => process.env.ORBITA_FAKE_VERSION || app.getVersion()

export async function checkForUpdate(fetcher: Fetch): Promise<UpdateInfo> {
  const r = await fetcher(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Orbita/${app.getVersion()}` }
  })
  if (r.status === 404) {
    return { current: currentVersion(), latest: currentVersion(), available: false, notes: '', url: `${REPO_URL}/releases` }
  }
  if (!r.ok) throw new Error(`GitHub ответил ${r.status}`)
  const j = (await r.json()) as {
    tag_name: string
    body?: string
    html_url: string
    published_at?: string
    assets: { name: string; browser_download_url: string; size: number }[]
  }
  const latest = j.tag_name.replace(/^v/, '')
  const setup = j.assets.find((a) => /setup.*\.exe$/i.test(a.name))
  const portable = j.assets.find((a) => /portable.*\.exe$/i.test(a.name))
  return {
    current: currentVersion(),
    latest,
    available: compareVersions(latest, currentVersion()) > 0,
    notes: j.body ?? '',
    url: j.html_url,
    publishedAt: j.published_at,
    setupUrl: setup?.browser_download_url,
    setupSize: setup?.size,
    portableUrl: portable?.browser_download_url
  }
}

export const isPortable = (): boolean => Boolean(process.env.PORTABLE_EXECUTABLE_FILE)

/** Качает установщик во временную папку, сообщает прогресс 0..1. */
export async function downloadUpdate(
  info: UpdateInfo,
  fetcher: Fetch,
  onProgress: (p: number) => void
): Promise<string> {
  if (!info.setupUrl) throw new Error('В релизе нет установщика')
  const file = join(app.getPath('temp'), `Orbita-Setup-${info.latest}.exe`)
  if (existsSync(file) && info.setupSize && statSync(file).size === info.setupSize) {
    onProgress(1)
    return file
  }
  const r = await fetcher(info.setupUrl)
  if (!r.ok || !r.body) throw new Error(`Не удалось скачать: ${r.status}`)
  const total = Number(r.headers.get('content-length')) || info.setupSize || 0
  const out = createWriteStream(file)
  const reader = r.body.getReader()
  let got = 0
  let last = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    got += value.length
    if (!out.write(value)) await new Promise((res) => out.once('drain', res))
    if (total && Date.now() - last > 200) {
      last = Date.now()
      onProgress(got / total)
    }
  }
  await new Promise<void>((res, rej) => out.end((e?: Error) => (e ? rej(e) : res())))
  if (info.setupSize && got !== info.setupSize) throw new Error('Файл скачался не полностью')
  onProgress(1)
  return file
}

/** Тихая установка поверх текущей и перезапуск новой версии. */
export function runInstaller(file: string): void {
  spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref()
}
