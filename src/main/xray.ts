// Второе ядро — Xray. Нужно только для серверов с xhttp: на каждый такой профиль
// поднимается локальный SOCKS-вход, а sing-box ходит в него как в обычный socks-сервер.
import { ChildProcess, execFile, spawn } from 'child_process'
import { connect } from 'net'
import { unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { sys } from './admin'
import type { Profile } from '@shared/types'
import { buildXrayConfig, isXray, XrayOutbound } from '@shared/xray'
import { xrayBin } from './paths'
import { freePort } from './ports'

export function xrayVersion(): Promise<string> {
  return new Promise((resolve) => {
    execFile(xrayBin(), ['version'], { windowsHide: true }, (err, out) =>
      resolve(err ? 'не найдено' : (out.match(/Xray\s+(\S+)/)?.[1] ?? '?'))
    )
  })
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1')
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('error', () => resolve(false))
  })
}

export class XrayRunner {
  private proc: ChildProcess | null = null
  private cfgPath = ''

  constructor(
    private dir: string,
    private onLog: (level: 'info' | 'warn' | 'error', text: string) => void = () => {}
  ) {}

  /** Поднимает Xray для xhttp-профилей из списка. Возвращает id → локальный порт (пусто, если таких нет). */
  async start(profiles: Profile[]): Promise<Record<string, number>> {
    await this.stop()
    const list = profiles.filter((p) => isXray(p.outbound))
    if (!list.length) return {}
    const items: { id: string; outbound: XrayOutbound; port: number }[] = []
    for (const p of list) items.push({ id: p.id, outbound: p.outbound as XrayOutbound, port: await freePort() })

    this.cfgPath = join(this.dir, `xray-${process.pid}-${Date.now()}.json`)
    writeFileSync(this.cfgPath, JSON.stringify(buildXrayConfig(items), null, 2))

    const proc = spawn(xrayBin(), ['run', '-c', this.cfgPath], { windowsHide: true, cwd: this.dir })
    this.proc = proc
    const onData = (buf: Buffer): void => {
      for (const raw of buf.toString('utf-8').split(/\r?\n/)) {
        const line = raw.trim()
        if (!line) continue
        const level = /\[(Error|Warning)\]/.exec(line)?.[1]
        this.onLog(level === 'Error' ? 'error' : level === 'Warning' ? 'warn' : 'info', `[xray] ${line}`)
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    let exited = false
    proc.once('exit', (code) => {
      exited = true
      if (this.proc === proc) {
        this.proc = null
        this.onLog('error', `[xray] процесс завершился с кодом ${code}`)
      }
    })

    // Ждём, пока откроются все порты.
    const end = Date.now() + 6000
    for (const it of items) {
      while (!(await portOpen(it.port))) {
        if (exited || Date.now() > end) {
          await this.stop()
          throw new Error('Xray не запустился, подробности в логах')
        }
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    this.onLog('info', `[xray] запущен, xhttp-серверов: ${items.length}`)
    return Object.fromEntries(items.map((it) => [it.id, it.port]))
  }

  get running(): boolean {
    return !!this.proc
  }

  async stop(): Promise<void> {
    const proc = this.proc
    this.proc = null
    if (proc) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          execFile(sys('taskkill.exe'), ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve())
        }, 2000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
        proc.kill()
      })
    }
    if (this.cfgPath) {
      try {
        unlinkSync(this.cfgPath)
      } catch {
        /* уже нет */
      }
      this.cfgPath = ''
    }
  }
}
