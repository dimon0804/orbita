// Проверка outbound'ов ядром: импорт из NekoBox и/или файла подписки → `sing-box check`.
// Запуск: node scripts/check-outbounds.mjs [--neko <папка config NekoBox>] [--sub <файл подписки>]
// Печатает только счётчики — без адресов, паролей и ключей.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SING_BOX = join(root, 'resources', 'core', 'sing-box.exe')

// .ts грузим через встроенное в node 22 удаление типов
const { importNekobox } = await import(new URL('../src/main/nekobox.ts', import.meta.url))
const { parseSubscription } = await import(new URL('../src/shared/links.ts', import.meta.url))

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** Проверка одним конфигом; если упал — по одному, чтобы посчитать битые. */
function check(outbounds) {
  const dir = mkdtempSync(join(tmpdir(), 'orbita-check-'))
  const run = (list) => {
    const file = join(dir, 'c.json')
    writeFileSync(file, JSON.stringify({
      log: { level: 'error' },
      inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: 0 }],
      outbounds: list.map((o, i) => ({ ...o, tag: `p${i}` }))
    }))
    return spawnSync(SING_BOX, ['check', '-c', file], { encoding: 'utf8' }).status === 0
  }
  try {
    if (run(outbounds)) return { ok: outbounds.length, bad: [] }
    const bad = []
    outbounds.forEach((o, i) => { if (!run([o])) bad.push({ i, type: o.type }) })
    return { ok: outbounds.length - bad.length, bad }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function countBy(list, key) {
  const m = {}
  for (const x of list) m[key(x)] = (m[key(x)] || 0) + 1
  return m
}

let failed = false
const neko = arg('--neko')
if (neko) {
  const r = importNekobox(neko)
  console.log(`NekoBox: групп ${r.groups.length}, профилей ${r.profiles.length}, пропущено ${r.skipped}`)
  console.log('  по группам:', countBy(r.profiles, (p) => p.nekoGroupId))
  console.log('  по типам:', countBy(r.profiles, (p) => p.outbound.type + (p.outbound.transport ? '/' + p.outbound.transport.type : '') + (p.outbound.tls?.reality ? '/reality' : p.outbound.tls ? '/tls' : '')))
  const c = check(r.profiles.map((p) => p.outbound))
  console.log(`  sing-box check: ок ${c.ok}, ошибок ${c.bad.length}`, c.bad.length ? c.bad : '')
  failed ||= c.bad.length > 0
}
const sub = arg('--sub')
if (sub) {
  const list = parseSubscription(readFileSync(sub, 'utf8'))
  console.log(`Подписка: профилей ${list.length}`, countBy(list, (p) => p.outbound.type))
  const c = check(list.map((p) => p.outbound))
  console.log(`  sing-box check: ок ${c.ok}, ошибок ${c.bad.length}`, c.bad.length ? c.bad : '')
  failed ||= c.bad.length > 0
}
if (!neko && !sub) console.log('Укажи --neko <папка> и/или --sub <файл>')
process.exit(failed ? 1 : 0)
