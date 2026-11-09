// Скачивает ядра для Windows в resources/core: sing-box (основное) и Xray (для xhttp).
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, renameSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const SING_BOX = process.env.SING_BOX_VERSION || '1.14.4'
const XRAY = process.env.XRAY_VERSION || '26.10.31'
const dir = join(process.cwd(), 'resources', 'core')
const force = process.argv.includes('--force')
// tar из Git Bash не понимает пути C:\..., берём системный
const sysTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
const tar = process.platform === 'win32' && existsSync(sysTar) ? sysTar : 'tar'
mkdirSync(dir, { recursive: true })

async function download(url, to) {
  console.log('качаю', url)
  const r = await fetch(url)
  if (!r.ok) throw new Error(`ответ ${r.status} на ${url}`)
  writeFileSync(to, Buffer.from(await r.arrayBuffer()))
}

if (existsSync(join(dir, 'sing-box.exe')) && !force) {
  console.log('sing-box уже есть')
} else {
  const name = `sing-box-${SING_BOX}-windows-amd64`
  const zip = join(dir, 'core.zip')
  await download(`https://github.com/SagerNet/sing-box/releases/download/v${SING_BOX}/${name}.zip`, zip)
  execFileSync(tar, ['-xf', zip, '-C', dir])
  for (const f of readdirSync(join(dir, name))) renameSync(join(dir, name, f), join(dir, f))
  rmSync(join(dir, name), { recursive: true })
  rmSync(zip)
  console.log('sing-box готов:', SING_BOX)
}

if (existsSync(join(dir, 'xray.exe')) && !force) {
  console.log('xray уже есть')
} else {
  const tmp = join(dir, 'xray-tmp')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp)
  const zip = join(tmp, 'xray.zip')
  await download(`https://github.com/XTLS/Xray-core/releases/download/v${XRAY}/Xray-windows-64.zip`, zip)
  execFileSync(tar, ['-xf', zip, '-C', tmp])
  // geoip/geosite не нужны: маршрутизацией занимается sing-box
  renameSync(join(tmp, 'xray.exe'), join(dir, 'xray.exe'))
  renameSync(join(tmp, 'LICENSE'), join(dir, 'LICENSE-xray'))
  rmSync(tmp, { recursive: true })
  console.log('xray готов:', XRAY)
}
