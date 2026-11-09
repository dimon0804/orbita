import { sys } from './admin'
import { ChildProcess, execFile, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { freePort } from './ports'
import { XrayRunner } from './xray'
import type { ConnectMode, CoreStatus, LogLine, Profile, Settings } from '@shared/types'
import { buildConfig, buildTestConfig } from './configBuilder'
import { coreBin, rulesDir } from './paths'
import { dataDir } from './store'
import { clearSystemProxy, setSystemProxy } from './sysproxy'

const MAX_LOGS = 3000

export interface Traffic {
  up: number
  down: number
}

export function coreVersion(): Promise<string> {
  return new Promise((resolve) => {
    execFile(coreBin(), ['version'], { windowsHide: true }, (err, out) =>
      resolve(err ? 'не найдено' : (out.match(/version\s+(\S+)/)?.[1] ?? '?'))
    )
  })
}

function checkConfig(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(coreBin(), ['check', '-c', path, '--disable-color'], { windowsHide: true }, (err, out, errOut) =>
      resolve(err ? (errOut || out || String(err)).trim() : null)
    )
  })
}

export { freePort }

function parseLevel(line: string): LogLine['level'] {
  const m = line.match(/^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL|PANIC)/i)
  const l = m?.[1].toLowerCase()
  if (l === 'panic') return 'fatal'
  return (l as LogLine['level']) ?? 'info'
}

export class Core extends EventEmitter {
  status: CoreStatus = { state: 'stopped' }
  logs: LogLine[] = []
  private proc: ChildProcess | null = null
  private secret = ''
  private port = 0
  private mixedPort = 0
  private trafficAbort: AbortController | null = null
  private stopping = false
  /** Порт, на который kill switch оставил системный прокси после падения ядра. */
  private heldProxyPort: number | null = null

  get holdingProxy(): boolean {
    return this.heldProxyPort !== null
  }

  async releaseHeldProxy(): Promise<void> {
    if (this.heldProxyPort === null) return
    const port = this.heldProxyPort
    this.heldProxyPort = null
    await clearSystemProxy(port).catch(() => {})
  }
  private xray = new XrayRunner(dataDir(), (level, text) => this.log(level, text))

  private log(level: LogLine['level'], text: string): void {
    const line = { t: Date.now(), level, text }
    this.logs.push(line)
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS)
    this.emit('log', line)
  }

  private setStatus(s: CoreStatus): void {
    this.status = s
    this.emit('status', s)
  }

  get running(): boolean {
    return this.status.state === 'running'
  }

  async start(o: {
    settings: Settings
    profiles: Profile[]
    selected: string
    mode: ConnectMode
    isAdmin: boolean
  }): Promise<void> {
    if (this.proc) await this.stop()
    // В режиме «системный» прокси тут же поставим заново — не снимаем, чтобы не было окна без защиты.
    if (o.mode === 'system') this.heldProxyPort = null
    else await this.releaseHeldProxy()
    if (o.mode === 'tun' && !o.isAdmin) {
      this.setStatus({ state: 'error', error: 'Для режима TUN нужны права администратора' })
      throw new Error(this.status.error)
    }
    this.setStatus({ state: 'starting', mode: o.mode, profileId: o.selected })
    this.secret = randomBytes(12).toString('hex')
    this.port = await freePort()
    this.mixedPort = o.settings.mixedPort

    let xrayPorts: Record<string, number> = {}
    try {
      xrayPorts = await this.xray.start(o.profiles)
    } catch (e) {
      // xhttp-серверы выпадут из группы, остальные работают
      this.log('error', String(e))
      if (o.profiles.find((p) => p.id === o.selected)?.outbound.type === 'xray') {
        this.setStatus({ state: 'error', error: 'Xray не запустился' })
        throw e
      }
    }

    const cfgPath = join(dataDir(), 'config.json')
    const write = (profiles: Profile[]): void => {
      const cfg = buildConfig({
        settings: o.settings,
        profiles,
        selected: o.selected,
        mode: o.mode,
        rulesDir: rulesDir(),
        dataDir: dataDir(),
        clashSecret: this.secret,
        clashPort: this.port,
        xrayPorts
      })
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    }

    write(o.profiles)
    let err = await checkConfig(cfgPath)
    if (err && o.profiles.length > 1) {
      // В группе есть битый профиль — запускаем только выбранный.
      this.log('warn', `Конфиг группы не прошёл проверку, запускаю только выбранный профиль: ${err}`)
      const one = o.profiles.filter((p) => p.id === o.selected)
      write(one.length ? one : o.profiles.slice(0, 1))
      err = await checkConfig(cfgPath)
    }
    if (err) {
      this.log('error', err)
      await this.xray.stop()
      this.setStatus({ state: 'error', error: err.split('\n').pop() })
      throw new Error(err)
    }

    this.log('info', `Запуск ядра: режим ${o.mode}, профилей в конфиге ${o.profiles.length}`)
    const proc = spawn(coreBin(), ['run', '-c', cfgPath, '-D', dataDir(), '--disable-color'], {
      windowsHide: true,
      cwd: dataDir()
    })
    this.proc = proc
    this.stopping = false

    const onData = (buf: Buffer): void => {
      for (const raw of buf.toString('utf-8').split(/\r?\n/)) {
        const line = raw.trim()
        if (line) this.log(parseLevel(line), line)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    this.emit('pid', proc.pid)
    proc.on('exit', (code) => {
      // Поздний exit старого процесса не должен трогать новый.
      if (this.proc !== proc) return
      this.proc = null
      this.stopTraffic()
      void this.xray.stop()
      this.emit('pid', undefined)
      if (this.stopping) {
        this.setStatus({ state: 'stopped' })
      } else {
        // Упало само. Без kill switch снимаем системный прокси, иначе интернет пропадёт;
        // с kill switch оставляем — браузеры упрутся в мёртвый порт и не пойдут напрямую.
        if (o.mode === 'system') {
          if (o.settings.killSwitch) this.heldProxyPort = this.mixedPort
          else void clearSystemProxy(this.mixedPort).catch(() => {})
        }
        this.log('error', `Ядро завершилось с кодом ${code}`)
        this.setStatus({ state: 'error', error: `Ядро неожиданно остановилось (код ${code})` })
      }
    })

    // Ждём, пока поднимется clash api.
    const ok = await this.waitReady(8000)
    if (!ok) {
      const tail = this.logs.slice(-3).map((l) => l.text).join('\n')
      await this.stop()
      this.setStatus({ state: 'error', error: tail || 'Ядро не запустилось' })
      throw new Error(this.status.error)
    }
    if (o.mode === 'system') {
      try {
        await setSystemProxy(o.settings.mixedPort)
      } catch (e) {
        this.log('error', `Не удалось включить системный прокси: ${e}`)
      }
    }
    this.setStatus({ state: 'running', mode: o.mode, profileId: o.selected, startedAt: Date.now() })
    this.startTraffic()
  }

  async stop(): Promise<void> {
    const proc = this.proc
    await this.releaseHeldProxy()
    if (!proc) {
      await this.xray.stop()
      if (this.status.state !== 'stopped') this.setStatus({ state: 'stopped' })
      return
    }
    const mode = this.status.mode
    this.stopping = true
    this.setStatus({ ...this.status, state: 'stopping' })
    this.stopTraffic()
    if (mode === 'system') await clearSystemProxy(this.mixedPort).catch(() => {})
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        execFile(sys('taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      }, 3000)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
      proc.kill()
    })
    if (this.proc === proc) this.proc = null
    await this.xray.stop()
    this.emit('pid', undefined)
    this.setStatus({ state: 'stopped' })
    this.log('info', 'Ядро остановлено')
  }

  private async waitReady(ms: number): Promise<boolean> {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (!this.proc) return false
      try {
        const r = await this.api('/version')
        if (r) return true
      } catch {
        /* ещё не поднялось */
      }
      await new Promise((r) => setTimeout(r, 150))
    }
    return false
  }

  async api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json', ...init?.headers },
      signal: init?.signal ?? AbortSignal.timeout(10000)
    })
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
    const text = await r.text()
    return (text ? JSON.parse(text) : null) as T
  }

  private startTraffic(): void {
    this.stopTraffic()
    const ctrl = new AbortController()
    this.trafficAbort = ctrl
    void (async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/traffic`, {
          headers: { Authorization: `Bearer ${this.secret}` },
          signal: ctrl.signal
        })
        const reader = r.body!.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim()
            buf = buf.slice(i + 1)
            if (line) {
              try {
                this.emit('traffic', JSON.parse(line) as Traffic)
              } catch {
                /* неполная строка */
              }
            }
          }
        }
      } catch {
        /* остановлено */
      }
    })()
  }

  private stopTraffic(): void {
    this.trafficAbort?.abort()
    this.trafficAbort = null
  }

  /** Переключение сервера внутри работающей группы — без перезапуска ядра. */
  async select(id: string): Promise<void> {
    const name = id.startsWith('auto:') ? 'auto' : id
    await this.api('/proxies/proxy', { method: 'PUT', body: JSON.stringify({ name }) })
    this.setStatus({ ...this.status, profileId: id })
  }

  async proxies(): Promise<Record<string, { now?: string; history?: { delay: number }[] }>> {
    const r = await this.api<{ proxies: Record<string, { now?: string; history?: { delay: number }[] }> }>(
      '/proxies'
    )
    return r.proxies
  }

  connections(): Promise<unknown> {
    return this.api('/connections')
  }

  closeConnection(id?: string): Promise<unknown> {
    return this.api(id ? `/connections/${id}` : '/connections', { method: 'DELETE' })
  }

  get proxyPort(): number {
    return this.mixedPort
  }
}

/**
 * Замер задержки: временное ядро только с исходящими и clash api,
 * чтобы мерить даже когда основное подключение выключено.
 */
export async function measureLatency(
  profiles: Profile[],
  url: string,
  onResult: (id: string, delay: number | null) => void
): Promise<void> {
  if (!profiles.length) return
  const port = await freePort()
  const secret = randomBytes(8).toString('hex')
  const cfgPath = join(dataDir(), `test-${port}.json`)

  const xray = new XrayRunner(dataDir())
  let xp: Record<string, number> = {}
  try {
    xp = await xray.start(profiles)
  } catch {
    /* xhttp-профили получат «нет ответа» */
  }
  let list = profiles.filter((p) => p.outbound.type !== 'xray' || xp[p.id])
  for (const p of profiles) if (!list.includes(p)) onResult(p.id, null)
  writeFileSync(cfgPath, JSON.stringify(buildTestConfig(list, port, secret, xp)))
  const err = await checkConfig(cfgPath)
  if (err) {
    // Отсеиваем профили, которые ядро не принимает.
    const good: Profile[] = []
    for (const p of list) {
      writeFileSync(cfgPath, JSON.stringify(buildTestConfig([p], port, secret, xp)))
      if (await checkConfig(cfgPath)) onResult(p.id, null)
      else good.push(p)
    }
    list = good
    writeFileSync(cfgPath, JSON.stringify(buildTestConfig(list, port, secret, xp)))
  }
  if (!list.length) {
    await xray.stop()
    return
  }

  const proc = spawn(coreBin(), ['run', '-c', cfgPath, '--disable-color'], { windowsHide: true, cwd: dataDir() })
  const base = `http://127.0.0.1:${port}`
  const headers = { Authorization: `Bearer ${secret}` }
  try {
    const end = Date.now() + 8000
    for (;;) {
      try {
        if ((await fetch(base + '/version', { headers })).ok) break
      } catch {
        /* ждём */
      }
      if (Date.now() > end) throw new Error('тестовое ядро не поднялось')
      await new Promise((r) => setTimeout(r, 150))
    }
    const queue = [...list]
    const worker = async (): Promise<void> => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        try {
          const r = await fetch(
            `${base}/proxies/${encodeURIComponent(p.id)}/delay?timeout=6000&url=${encodeURIComponent(url)}`,
            { headers, signal: AbortSignal.timeout(9000) }
          )
          const j = (await r.json()) as { delay?: number }
          onResult(p.id, r.ok && j.delay ? j.delay : null)
        } catch {
          onResult(p.id, null)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(12, list.length) }, worker))
  } finally {
    proc.kill()
    await xray.stop()
    try {
      unlinkSync(cfgPath)
    } catch {
      /* уже нет */
    }
  }
}

/**
 * Временный локальный прокси, который ведёт ровно в один профиль (для теста скорости).
 * fn получает порт mixed-входа; ядро гасится после fn.
 */
export async function withProfileProxy<T>(profile: Profile, fn: (port: number) => Promise<T>): Promise<T> {
  const api = await freePort()
  const listen = await freePort()
  const secret = randomBytes(8).toString('hex')
  const cfgPath = join(dataDir(), `speed-${listen}.json`)
  const xray = new XrayRunner(dataDir())
  const xp = await xray.start([profile])
  let proc: ChildProcess | null = null
  try {
    writeFileSync(cfgPath, JSON.stringify(buildTestConfig([profile], api, secret, xp, { listenPort: listen, profileId: profile.id })))
    const err = await checkConfig(cfgPath)
    if (err) throw new Error(err.split(/\r?\n/).pop())
    proc = spawn(coreBin(), ['run', '-c', cfgPath, '--disable-color'], { windowsHide: true, cwd: dataDir() })
    const end = Date.now() + 8000
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${api}/version`, { headers: { Authorization: `Bearer ${secret}` } })).ok) break
      } catch {
        /* ждём */
      }
      if (Date.now() > end) throw new Error('тестовое ядро не поднялось')
      await new Promise((r) => setTimeout(r, 150))
    }
    return await fn(listen)
  } finally {
    proc?.kill()
    await xray.stop()
    try {
      unlinkSync(cfgPath)
    } catch {
      /* уже нет */
    }
  }
}
