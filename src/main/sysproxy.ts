import { sys } from './admin'
import { execFile } from 'child_process'

// Системный прокси Windows. Делаем сами, а не через set_system_proxy ядра:
// при принудительной остановке sing-box не успевает за собой убрать прокси.

const KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

const REFRESH = `
Add-Type -Namespace W -Name I -MemberDefinition '[DllImport("wininet.dll")] public static extern bool InternetSetOption(System.IntPtr h, int o, System.IntPtr b, int l);'
[W.I]::InternetSetOption([System.IntPtr]::Zero, 39, [System.IntPtr]::Zero, 0) | Out-Null
[W.I]::InternetSetOption([System.IntPtr]::Zero, 37, [System.IntPtr]::Zero, 0) | Out-Null`

const BYPASS = 'localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>'

function ps(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(sys('WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    )
  })
}

export function setSystemProxy(port: number): Promise<string> {
  return ps(`
Set-ItemProperty -Path '${KEY}' -Name ProxyServer -Value '127.0.0.1:${port}'
Set-ItemProperty -Path '${KEY}' -Name ProxyOverride -Value '${BYPASS}'
Set-ItemProperty -Path '${KEY}' -Name ProxyEnable -Value 1 -Type DWord
${REFRESH}`)
}

/** Снимаем прокси, только если он наш (указывает на наш порт), чтобы не сломать чужие настройки. */
export function clearSystemProxy(port: number): Promise<string> {
  return ps(`
$p = Get-ItemProperty -Path '${KEY}'
if ($p.ProxyEnable -eq 1 -and $p.ProxyServer -eq '127.0.0.1:${port}') {
  Set-ItemProperty -Path '${KEY}' -Name ProxyEnable -Value 0 -Type DWord
  ${REFRESH}
  'cleared'
}`)
}
