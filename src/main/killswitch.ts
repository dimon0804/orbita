// Kill switch для TUN: если ядро упало, интернет закрывается брандмауэром Windows,
// пока подключение не вернётся. Наружу пускаем только ядра Orbita — им нужно переподключиться.
// Прежнюю политику профилей запоминаем и возвращаем как было.
import { execFile } from 'child_process'
import { sys } from './admin'

const GROUP = 'Orbita kill switch'

/** Имя профиля брандмауэра → прежнее действие по умолчанию для исходящих. */
export type FirewallBackup = Record<string, string>

function ps(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      sys('WindowsPowerShell\\v1.0\\powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 30_000 },
      (err, out, errOut) => (err ? reject(new Error((errOut || String(err)).trim())) : resolve(out.trim()))
    )
  })
}

const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** Включает блокировку. Возвращает прежние настройки и список выключенных профилей брандмауэра. */
export async function engageKillSwitch(allowPrograms: string[]): Promise<{ backup: FirewallBackup; disabled: string[] }> {
  const allow = allowPrograms
    .map((p) => `New-NetFirewallRule -DisplayName ${quote(GROUP)} -Group ${quote(GROUP)} -Direction Outbound -Action Allow -Program ${quote(p)} | Out-Null`)
    .join('; ')
  const out = await ps(
    [
      '$ErrorActionPreference = "Stop"',
      '$prev = Get-NetFirewallProfile | ForEach-Object { "$($_.Name)=$($_.DefaultOutboundAction)=$($_.Enabled)" }',
      `Remove-NetFirewallRule -Group ${quote(GROUP)} -ErrorAction SilentlyContinue`,
      allow,
      'Set-NetFirewallProfile -All -DefaultOutboundAction Block',
      '$prev -join ";"'
    ].join('; ')
  )
  const backup: FirewallBackup = {}
  const disabled: string[] = []
  for (const part of out.split(';')) {
    const [name, action, enabled] = part.split('=')
    if (!name) continue
    backup[name] = action || 'NotConfigured'
    if (enabled === 'False') disabled.push(name)
  }
  return { backup, disabled }
}

export async function releaseKillSwitch(backup: FirewallBackup): Promise<void> {
  const restore = Object.entries(backup)
    .filter(([, a]) => /^(Allow|Block|NotConfigured)$/.test(a))
    .map(([n, a]) => `Set-NetFirewallProfile -Name ${quote(n)} -DefaultOutboundAction ${a}`)
  await ps(
    [
      '$ErrorActionPreference = "Stop"',
      ...(restore.length ? restore : ['Set-NetFirewallProfile -All -DefaultOutboundAction Allow']),
      `Remove-NetFirewallRule -Group ${quote(GROUP)} -ErrorAction SilentlyContinue`
    ].join('; ')
  )
}
