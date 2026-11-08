// Скачивает ядро sing-box для Windows в resources/core.
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, renameSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'

const VERSION = process.env.SING_BOX_VERSION || '1.14.4'
const dir = join(process.cwd(), 'resources', 'core')
if (existsSync(join(dir, 'sing-box.exe')) && !process.argv.includes('--force')) {
  console.log('ядро уже есть:', join(dir, 'sing-box.exe'))
  process.exit(0)
}
mkdirSync(dir, { recursive: true })
const name = `sing-box-${VERSION}-windows-amd64`
const zip = join(dir, 'core.zip')
const url = `https://github.com/SagerNet/sing-box/releases/download/v${VERSION}/${name}.zip`
console.log('качаю', url)
const r = await fetch(url)
if (!r.ok) throw new Error(`ответ ${r.status}`)
const { writeFileSync } = await import('fs')
writeFileSync(zip, Buffer.from(await r.arrayBuffer()))
execFileSync('tar', ['-xf', zip, '-C', dir])
for (const f of readdirSync(join(dir, name))) renameSync(join(dir, name, f), join(dir, f))
rmSync(join(dir, name), { recursive: true })
rmSync(zip)
console.log('готово:', VERSION)
