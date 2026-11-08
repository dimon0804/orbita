import { app } from 'electron'
import { execFile, execFileSync } from 'child_process'
import { join as pjoin } from 'path'

/** Системные утилиты — только по полному пути, чтобы не подхватить чужие из PATH. */
export const sys = (exe: string): string => pjoin(process.env.SystemRoot || 'C:/Windows', 'System32', exe)

// Права администратора нужны для TUN. Чтобы UAC спрашивал только один раз,
// при первом запуске с повышением регистрируем задачу планировщика с наивысшими правами.
// Дальше обычный запуск exe просто стартует эту задачу и выходит — без окна UAC.

const ELEVATED_TASK = 'Orbita (admin)'
const LOGON_TASK = 'Orbita (autostart)'

let cached: boolean | null = null

/** Проверяем уровень целостности токена: High (S-1-16-12288) — значит, процесс повышен. */
export function isAdmin(): boolean {
  if (cached !== null) return cached
  try {
    const out = execFileSync(sys('whoami.exe'), ['/groups'], { windowsHide: true, encoding: 'utf-8' })
    cached = /S-1-16-12288|S-1-16-16384/.test(out)
  } catch {
    cached = false
  }
  return cached
}

function taskExists(name: string): boolean {
  try {
    execFileSync(sys('schtasks.exe'), ['/Query', '/TN', name], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** Путь к exe. Портативная версия распаковывается во временную папку — берём исходный файл. */
const exePath = (): string => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath

const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`

/**
 * Задача через Register-ScheduledTask: без даты в локальном формате, без лимита 72 часа,
 * работает на батарее, параллельные запуски разрешены (вторая копия упрётся в single-instance lock
 * и просто покажет окно первой).
 */
function createTask(name: string, atLogon: boolean, extra: string[] = []): void {
  const args = [...(app.isPackaged ? [] : [`"${app.getAppPath()}"`]), ...extra].join(' ')
  const script = `
$a = New-ScheduledTaskAction -Execute ${psq(exePath())} ${args ? `-Argument ${psq(args)}` : ''}
$p = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances Parallel -StartWhenAvailable
${atLogon ? '$t = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)' : ''}
Register-ScheduledTask -TaskName ${psq(name)} -Action $a -Principal $p -Settings $s ${atLogon ? '-Trigger $t' : ''} -Force | Out-Null`
  execFileSync(sys('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 20000
  })
}

export interface ElevationState {
  enabled: boolean
  declined?: boolean
  onDeclined: () => void
}

/**
 * Вызывается в самом начале. Возвращает true, если этот процесс надо закрыть:
 * повышенная копия уже запускается.
 */
export function ensureElevated(o: ElevationState): boolean {
  if (process.platform !== 'win32') return false
  if (isAdmin()) {
    if (o.enabled && !taskExists(ELEVATED_TASK)) {
      try {
        createTask(ELEVATED_TASK, false)
      } catch {
        /* не критично: просто спросим UAC в следующий раз */
      }
    }
    return false
  }
  if (!o.enabled || process.argv.includes('--no-elevate')) return false
  if (taskExists(ELEVATED_TASK)) {
    try {
      execFileSync(sys('schtasks.exe'), ['/Run', '/TN', ELEVATED_TASK], { stdio: 'ignore', windowsHide: true })
      return true
    } catch {
      return false
    }
  }
  // Задачи ещё нет — один раз просим UAC; повышенная копия сама зарегистрирует задачу.
  // Если человек уже отказал — больше сами не спрашиваем, только по кнопке.
  if (app.isPackaged && !o.declined && !process.argv.includes('--elevate-asked')) {
    try {
      execFileSync(sys('WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-Command', `Start-Process -FilePath ${psq(exePath())} -ArgumentList '--elevate-asked' -Verb RunAs`],
        { stdio: 'ignore', windowsHide: true }
      )
      return true
    } catch {
      o.onDeclined()
      return false
    }
  }
  return false
}

export function enableElevatedTask(): void {
  if (isAdmin() && !taskExists(ELEVATED_TASK)) createTask(ELEVATED_TASK, false)
}

export function removeElevatedTask(): void {
  execFile(sys('schtasks.exe'), ['/Delete', '/F', '/TN', ELEVATED_TASK], { windowsHide: true }, () => {})
}

export function relaunchAsAdmin(): Promise<boolean> {
  const args = [...(app.isPackaged ? [] : [`"${app.getAppPath()}"`]), '--elevate-asked']
  app.releaseSingleInstanceLock()
  return new Promise((resolve) => {
    execFile(sys('WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-Command', `Start-Process -FilePath ${psq(exePath())} -ArgumentList ${psq(args.join(' '))} -Verb RunAs`],
      { windowsHide: true },
      (err) => {
        if (err) {
          app.requestSingleInstanceLock()
          return resolve(false) // пользователь отказал в UAC
        }
        app.exit(0)
        resolve(true)
      }
    )
  })
}

/**
 * Автозапуск. Под админом — задача планировщика при входе с наивысшими правами,
 * чтобы TUN работал сразу и без UAC. Если не вышло — обычный ключ Run.
 */
export function setAutostart(on: boolean, minimized: boolean): void {
  const extra = minimized ? ['--hidden'] : []
  if (isAdmin()) {
    try {
      if (on) createTask(LOGON_TASK, true, extra)
      else if (taskExists(LOGON_TASK)) execFileSync(sys('schtasks.exe'), ['/Delete', '/F', '/TN', LOGON_TASK], { stdio: 'ignore', windowsHide: true })
      app.setLoginItemSettings({ openAtLogin: false })
      return
    } catch {
      /* падаем на ключ Run */
    }
  }
  app.setLoginItemSettings({ openAtLogin: on, args: extra })
}
