import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from 'electron'
import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ConnectMode, Group, Outbound, Profile, RouteMode, Settings } from '@shared/types'
import { parseLink, parseSubscription, parseSubscriptionInfo, toLink } from '@shared/links'
import { addTraffic, db, newId, save } from './store'
import { Core, coreVersion, measureLatency } from './core'
import { sys, enableElevatedTask, ensureElevated, isAdmin, relaunchAsAdmin, removeElevatedTask, setAutostart } from './admin'
import { iconPath } from './paths'
import { clearSystemProxy } from './sysproxy'
import { importNekobox } from './nekobox'
import { checkForUpdate, currentVersion, downloadUpdate, isPortable, runInstaller, UpdateInfo } from './updater'

const core = new Core()
let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

// Отдельная папка данных — для тестов и портативного режима.
if (process.env.ORBITA_DATA) app.setPath('userData', process.env.ORBITA_DATA)
// Права админа: один раз через UAC, дальше — через задачу планировщика без вопросов.
if (
  ensureElevated({
    enabled: db().settings.runAsAdmin,
    declined: db().elevateDeclined,
    onDeclined: () => {
      db().elevateDeclined = true
      save(true)
    }
  })
)
  process.exit(0)
if (!app.requestSingleInstanceLock()) process.exit(0)

// Все операции с ядром — строго по очереди, иначе быстрые клики плодят процессы sing-box.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}
app.setAppUserModelId('dev.dimon0804.orbita')

// ───────── окно и трей ─────────

function createWindow(show: boolean): void {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#0d0d12',
    icon: iconPath('icon.png'),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  win.on('ready-to-show', () => show && win?.show())
  win.on('close', (e) => {
    if (!quitting && db().settings.closeToTray) {
      e.preventDefault()
      win?.hide()
    }
  })
  win.on('maximize', () => send('window', { maximized: true }))
  win.on('unmaximize', () => send('window', { maximized: false }))
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function showWindow(): void {
  if (!win) createWindow(true)
  else {
    win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
  }
}

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function updateTray(): void {
  if (!tray) return
  const s = db().settings
  const on = core.running
  const prof = db().profiles.find((p) => p.id === core.status.profileId)
  tray.setImage(nativeImage.createFromPath(iconPath(on ? 'tray-on.png' : 'tray-off.png')))
  tray.setToolTip(on ? `Orbita — подключено\n${prof?.name ?? 'авто'}` : 'Orbita — отключено')
  const mode = (m: ConnectMode, label: string): Electron.MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: s.connectMode === m,
    click: () => void setMode(m)
  })
  const route = (m: RouteMode, label: string): Electron.MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: s.routeMode === m,
    click: () => void patchSettings({ routeMode: m })
  })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: on ? `● ${prof?.name ?? 'Подключено'}` : '○ Отключено', enabled: false },
      { label: on ? 'Отключиться' : 'Подключиться', click: () => void toggle() },
      { type: 'separator' },
      mode('system', 'Системный прокси'),
      mode('tun', isAdmin() ? 'TUN (весь трафик)' : 'TUN (нужен админ)'),
      mode('proxy', 'Только локальный порт'),
      { type: 'separator' },
      route('rule', 'По правилам'),
      route('global', 'Всё через прокси'),
      route('direct', 'Всё напрямую'),
      { type: 'separator' },
      { label: 'Открыть Orbita', click: showWindow },
      {
        label: 'Выход',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

// ───────── состояние ─────────

function publicState(): unknown {
  const d = db()
  return {
    settings: d.settings,
    groups: [...d.groups].sort((a, b) => a.order - b.order),
    profiles: d.profiles,
    stats: d.stats,
    status: core.status,
    isAdmin: isAdmin(),
    version: currentVersion(),
    portable: isPortable(),
    update
  }
}

function broadcast(): void {
  send('state', publicState())
  updateTray()
}

async function patchSettings(patch: Partial<Settings>): Promise<void> {
  const d = db()
  const before = d.settings
  d.settings = { ...before, ...patch }
  save()
  if ('runAsAdmin' in patch) {
    if (patch.runAsAdmin) {
      d.elevateDeclined = false
      try {
        enableElevatedTask()
      } catch {
        /* без прав — задача создастся при запуске от администратора */
      }
    } else removeElevatedTask()
  }
  if ('hotkey' in patch) registerHotkey()
  if (patch.checkUpdates) void checkUpdates().catch(() => {})
  if ('launchOnStartup' in patch || 'startMinimized' in patch)
    setAutostart(d.settings.launchOnStartup, d.settings.startMinimized)
  broadcast()
  // Настройки, влияющие на конфиг ядра, требуют перезапуска.
  const coreKeys: (keyof Settings)[] = [
    'routeMode', 'mixedPort', 'allowLan', 'clashPort', 'tunStack', 'tunMtu', 'tunStrictRoute',
    'ipv6', 'dnsRemote', 'dnsDirect', 'bypassRu', 'blockAds', 'rules', 'logLevel', 'testUrl'
  ]
  if (core.running && coreKeys.some((k) => k in patch && JSON.stringify(before[k]) !== JSON.stringify(patch[k])))
    await connect().catch((e) => send('toast', { kind: 'error', text: errText(e) }))
}

async function setMode(m: ConnectMode): Promise<void> {
  if (m === 'tun' && !isAdmin()) {
    send('toast', { kind: 'warn', text: 'Для TUN нужны права администратора. Нажми «Перезапустить от администратора».' })
    return
  }
  const was = core.running
  db().settings.connectMode = m
  save()
  broadcast()
  if (was) await connect().catch((e) => send('toast', { kind: 'error', text: errText(e) }))
}

/** Группа выбранного: обычный профиль или «auto:<groupId>» — автовыбор лучшего в группе. */
function groupOf(id?: string): string | undefined {
  if (!id) return undefined
  if (id.startsWith('auto:')) return id.slice(5)
  return db().profiles.find((p) => p.id === id)?.groupId
}

function selectionValid(id?: string): boolean {
  if (!id) return false
  if (id.startsWith('auto:')) return db().profiles.some((p) => p.groupId === id.slice(5))
  return db().profiles.some((p) => p.id === id)
}

function groupProfiles(selectedId: string): Profile[] {
  const d = db()
  if (selectedId.startsWith('auto:')) return d.profiles.filter((p) => p.groupId === selectedId.slice(5))
  const sel = d.profiles.find((p) => p.id === selectedId)
  if (!sel) return []
  return d.profiles.filter((p) => p.groupId === sel.groupId)
}

function connect(): Promise<void> {
  return serial(doConnect)
}

async function doConnect(): Promise<void> {
  const d = db()
  let selected = d.settings.selectedProfileId
  if (!selectionValid(selected)) selected = d.profiles[0]?.id
  if (!selected) throw new Error('Добавь хотя бы один сервер')
  d.settings.selectedProfileId = selected
  try {
    await core.start({
      settings: d.settings,
      profiles: groupProfiles(selected),
      selected,
      mode: d.settings.connectMode,
      isAdmin: isAdmin()
    })
    d.dirty = d.settings.connectMode === 'system'
    wantConnected = true
    save()
    notify('Подключено', `${profileName(selected!)} · ${MODE_NAME[d.settings.connectMode]}`)
  } finally {
    await updateNetProxy().catch(() => {})
    broadcast()
  }
}

function disconnect(): Promise<void> {
  return serial(doDisconnect)
}

async function doDisconnect(): Promise<void> {
  wantConnected = false
  await core.stop()
  db().dirty = false
  save()
  await updateNetProxy()
  broadcast()
}

async function toggle(): Promise<void> {
  try {
    if (core.status.state === 'starting' || core.status.state === 'stopping') return
    if (core.running) await disconnect()
    else await connect()
  } catch (e) {
    send('toast', { kind: 'error', text: errText(e) })
  }
}

async function selectProfile(id: string): Promise<void> {
  const d = db()
  if (!selectionValid(id)) return
  const prevGroup = groupOf(core.status.profileId)
  d.settings.selectedProfileId = id
  save()
  if (core.running && core.status.profileId !== id) {
    if (prevGroup && prevGroup === groupOf(id)) await serial(() => core.select(id)).catch(() => connect())
    else await connect()
  }
  broadcast()
}

const MODE_NAME: Record<ConnectMode, string> = { system: 'системный прокси', tun: 'TUN', proxy: 'локальный порт' }

function profileName(id: string): string {
  if (id.startsWith('auto:')) return `Авто · ${db().groups.find((g) => g.id === id.slice(5))?.name ?? ''}`
  return db().profiles.find((p) => p.id === id)?.name ?? 'сервер'
}

/** Уведомление Windows — только когда окно не перед глазами. */
function notify(title: string, body: string, force = false): void {
  if (!db().settings.notifications || !Notification.isSupported()) return
  if (!force && win?.isVisible() && win.isFocused()) return
  const n = new Notification({ title, body, icon: iconPath('icon.png'), silent: true })
  n.on('click', showWindow)
  n.show()
}

// ───────── автопереподключение ─────────

let wantConnected = false
let crashes: number[] = []
function onCoreCrash(): void {
  notify('Ядро остановилось', core.status.error ?? 'Неизвестная ошибка', true)
  if (!wantConnected || !db().settings.autoReconnect) return
  crashes = crashes.filter((t) => Date.now() - t < 60_000)
  if (crashes.length >= 3) {
    notify('Не получается переподключиться', 'Ядро падает снова и снова. Загляни в логи.', true)
    wantConnected = false
    return
  }
  crashes.push(Date.now())
  setTimeout(() => {
    if (wantConnected && !core.running) void connect().catch(() => {})
  }, 2000)
}

// ───────── горячая клавиша ─────────

function registerHotkey(): void {
  globalShortcut.unregisterAll()
  const k = db().settings.hotkey.trim()
  if (!k) return
  try {
    if (!globalShortcut.register(k, () => void toggle())) send('toast', { kind: 'warn', text: `Сочетание ${k} занято другой программой` })
  } catch {
    send('toast', { kind: 'warn', text: `Не понимаю сочетание «${k}»` })
  }
}

// ───────── обновления ─────────

type UpdateState = UpdateInfo & {
  stage: 'idle' | 'downloading' | 'ready' | 'error'
  progress?: number
  file?: string
  error?: string
}
let update: UpdateState | null = null

async function checkUpdates(manual = false): Promise<UpdateInfo | null> {
  if (!manual && !db().settings.checkUpdates) return null
  const info = await checkForUpdate((u, i) => netSession().fetch(u, i))
  const same = update?.latest === info.latest
  const wasKnown = same && update!.available
  update = same ? { ...update!, ...info } : { ...info, stage: 'idle' }
  if (info.available && !wasKnown) notify(`Вышла Orbita ${info.latest}`, 'Открой приложение, чтобы обновиться.', true)
  broadcast()
  return info
}

async function startDownload(): Promise<void> {
  const u = update
  if (!u?.available) throw new Error('Обновлений нет')
  if (isPortable() || !u.setupUrl) {
    await shell.openExternal(u.url)
    return
  }
  u.stage = 'downloading'
  u.progress = 0
  u.error = undefined
  broadcast()
  try {
    u.file = await downloadUpdate(u, (url, i) => netSession().fetch(url, i), (p) => {
      u.progress = p
      send('update:progress', p)
    })
    u.stage = 'ready'
  } catch (e) {
    u.stage = 'error'
    u.error = errText(e)
    throw e
  } finally {
    broadcast()
  }
}

function installUpdate(): void {
  if (update?.stage !== 'ready' || !update.file) throw new Error('Обновление ещё не скачано')
  runInstaller(update.file)
  quitting = true
  app.quit()
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Свой сетевой сеанс для подписок и проверки IP: идёт через ядро, если оно запущено.
const netSession = (): Electron.Session => session.fromPartition('orbita-net')
async function updateNetProxy(): Promise<void> {
  await netSession().setProxy(
    core.running ? { proxyRules: `socks5://127.0.0.1:${core.proxyPort}` } : { mode: 'direct' }
  )
  await netSession().closeAllConnections()
}

// ───────── подписки ─────────

const decodeTitle = (t: string | null): string | undefined => {
  if (!t) return undefined
  if (t.startsWith('base64:')) return Buffer.from(t.slice(7), 'base64').toString('utf-8')
  return t
}

async function fetchSubscription(url: string, ua: string): Promise<{ text: string; info: Group['info']; title?: string }> {
  const r = await netSession().fetch(url, { headers: { 'User-Agent': ua } })
  if (!r.ok) throw new Error(`Подписка ответила ${r.status}`)
  const text = await r.text()
  return {
    text,
    info: parseSubscriptionInfo(r.headers.get('subscription-userinfo')) ?? undefined,
    title: decodeTitle(r.headers.get('profile-title'))
  }
}

const SUB_AGENTS = ['sing-box/1.14.4 Orbita', 'ClashMeta/1.19 mihomo', 'v2rayN/7.10']

async function updateSubscription(groupId: string): Promise<number> {
  const d = db()
  const g = d.groups.find((x) => x.id === groupId)
  if (!g?.url) throw new Error('Это не подписка')
  // Панели отдают разный формат в зависимости от User-Agent. Начинаем с sing-box,
  // если не разобралось — пробуем Clash и v2rayN.
  const agents = g.userAgent ? [g.userAgent] : [...SUB_AGENTS]
  let res: Awaited<ReturnType<typeof fetchSubscription>> | null = null
  let parsed: ReturnType<typeof parseSubscription> = []
  for (const ua of agents) {
    res = await fetchSubscription(g.url, ua)
    parsed = parseSubscription(res.text)
    if (parsed.length) break
  }
  if (!res || !parsed.length) throw new Error('В подписке не нашлось серверов')
  // Сохраняем статистику профилей с тем же именем и выбранный профиль.
  const old = d.profiles.filter((p) => p.groupId === groupId)
  const byName = new Map(old.map((p) => [p.name, p]))
  const fresh: Profile[] = parsed.map((p) => {
    const prev = byName.get(p.name)
    return {
      id: prev?.id ?? newId(),
      groupId,
      name: p.name,
      outbound: p.outbound,
      link: toLink(p) ?? undefined,
      createdAt: prev?.createdAt ?? Date.now(),
      traffic: prev?.traffic,
      latency: prev?.latency,
      latencyAt: prev?.latencyAt
    }
  })
  d.profiles = [...d.profiles.filter((p) => p.groupId !== groupId), ...fresh]
  g.updatedAt = Date.now()
  g.info = res.info
  if (res.title && g.name.startsWith('Подписка')) g.name = res.title
  save()
  broadcast()
  return fresh.length
}

function scheduleSubscriptions(): void {
  setInterval(() => {
    for (const g of db().groups) {
      const h = g.autoUpdateHours ?? 0
      if (g.kind === 'subscription' && h > 0 && Date.now() - (g.updatedAt ?? 0) > h * 3600_000)
        void updateSubscription(g.id).catch(() => {})
    }
  }, 10 * 60_000)
}

// ───────── добавление ─────────

async function addFromText(text: string, groupId?: string): Promise<{ added: number; group?: string }> {
  const d = db()
  const t = text.trim()
  if (/^https?:\/\/\S+$/i.test(t) && !/^https?:\/\/[^@/]+@/.test(t)) {
    // Ссылка на подписку.
    const g: Group = {
      id: newId(),
      name: 'Подписка ' + new URL(t).hostname,
      kind: 'subscription',
      url: t,
      autoUpdateHours: 12,
      order: d.groups.length
    }
    d.groups.push(g)
    try {
      const n = await updateSubscription(g.id)
      return { added: n, group: g.id }
    } catch (e) {
      d.groups = d.groups.filter((x) => x.id !== g.id)
      save()
      throw e
    }
  }
  const parsed = parseSubscription(t)
  const gid = groupId && d.groups.some((g) => g.id === groupId && g.kind === 'manual') ? groupId : 'default'
  if (!d.groups.some((g) => g.id === gid)) d.groups.unshift({ id: 'default', name: 'Мои серверы', kind: 'manual', order: -1 })
  for (const p of parsed)
    d.profiles.push({ id: newId(), groupId: gid, name: p.name, outbound: p.outbound, link: toLink(p) ?? undefined, createdAt: Date.now() })
  save()
  broadcast()
  return { added: parsed.length, group: gid }
}

function nekoDir(): string | null {
  const cands = [
    join(homedir(), 'Desktop', 'nekoray', 'config'),
    join(homedir(), 'Desktop', 'nekobox', 'config'),
    join(homedir(), 'Downloads', 'nekoray', 'config'),
    join(homedir(), 'AppData', 'Roaming', 'nekoray', 'config')
  ]
  return cands.find((c) => existsSync(join(c, 'profiles'))) ?? null
}

// ───────── IPC ─────────

function ipc(): void {
  const h = <A extends unknown[]>(ch: string, fn: (...a: A) => unknown): void => {
    ipcMain.handle(ch, async (_e, ...args) => {
      try {
        return { ok: true, data: await fn(...(args as A)) }
      } catch (e) {
        return { ok: false, error: errText(e) }
      }
    })
  }

  h('state', () => publicState())
  h('logs', () => core.logs)
  h('logs:clear', () => {
    core.logs = []
  })
  h('settings', (p: Partial<Settings>) => patchSettings(p))
  h('mode', (m: ConnectMode) => setMode(m))
  h('connect', () => connect())
  h('disconnect', () => disconnect())
  h('select', (id: string) => selectProfile(id))
  h('add:text', (text: string, gid?: string) => addFromText(text, gid))
  h('add:clipboard', async (gid?: string) => addFromText(await clipboard.readText(), gid))
  h('add:outbound', (name: string, outbound: Outbound, gid?: string) => {
    const d = db()
    const p: Profile = { id: newId(), groupId: gid ?? 'default', name, outbound, createdAt: Date.now() }
    p.link = toLink(p) ?? undefined
    d.profiles.push(p)
    save()
    broadcast()
    return p.id
  })
  h('profile:update', (id: string, patch: Partial<Profile>) => {
    const p = db().profiles.find((x) => x.id === id)
    if (!p) throw new Error('Профиль не найден')
    Object.assign(p, patch)
    if (patch.outbound || patch.name) p.link = toLink(p) ?? undefined
    save()
    broadcast()
  })
  h('profile:delete', (ids: string[]) => {
    const d = db()
    d.profiles = d.profiles.filter((p) => !ids.includes(p.id))
    save()
    broadcast()
  })
  h('profile:link', async (id: string) => {
    const p = db().profiles.find((x) => x.id === id)
    const link = p ? (p.link ?? toLink(p)) : null
    if (!link) throw new Error('Для этого протокола ссылку не собрать')
    await clipboard.writeText(link)
    return link
  })
  h('group:add', (name: string) => {
    const d = db()
    const g: Group = { id: newId(), name, kind: 'manual', order: d.groups.length }
    d.groups.push(g)
    save()
    broadcast()
    return g.id
  })
  h('group:update', (id: string, patch: Partial<Group>) => {
    const g = db().groups.find((x) => x.id === id)
    if (g) Object.assign(g, patch)
    save()
    broadcast()
  })
  h('group:delete', (id: string) => {
    const d = db()
    d.groups = d.groups.filter((g) => g.id !== id)
    d.profiles = d.profiles.filter((p) => p.groupId !== id)
    if (!d.groups.length) d.groups.push({ id: 'default', name: 'Мои серверы', kind: 'manual', order: 0 })
    save()
    broadcast()
  })
  h('group:refresh', (id: string) => updateSubscription(id))
  h('latency', async (ids: string[]) => {
    const d = db()
    const list = d.profiles.filter((p) => ids.includes(p.id))
    await measureLatency(list, d.settings.testUrl, (id, delay) => {
      const p = d.profiles.find((x) => x.id === id)
      if (p) {
        p.latency = delay
        p.latencyAt = Date.now()
      }
      send('latency', { id, delay })
    })
    save()
    broadcast()
  })
  h('connections', () => (core.running ? core.connections() : { connections: [] }))
  h('connections:close', (id?: string) => core.closeConnection(id))
  h('ip', async () => {
    const r = await netSession().fetch('https://ipwho.is/', { cache: 'no-store' })
    return r.json()
  })
  h('neko:detect', () => nekoDir())
  h('neko:import', (dir?: string) => {
    const src = dir || nekoDir()
    if (!src) throw new Error('Папка NekoBox не найдена')
    const res = importNekobox(src)
    const d = db()
    const map = new Map<number, string>()
    for (const g of res.groups) {
      const ng: Group = {
        id: newId(),
        name: g.name || `NekoBox ${g.nekoId}`,
        kind: g.url ? 'subscription' : 'manual',
        url: g.url,
        autoUpdateHours: g.url ? 12 : 0,
        order: d.groups.length
      }
      d.groups.push(ng)
      map.set(g.nekoId, ng.id)
    }
    let n = 0
    for (const p of res.profiles) {
      const gid = map.get(p.nekoGroupId)
      if (!gid) continue
      const prof: Profile = { id: newId(), groupId: gid, name: p.name, outbound: p.outbound, createdAt: Date.now() }
      prof.link = toLink(prof) ?? undefined
      d.profiles.push(prof)
      n++
    }
    // Пустые группы не тащим.
    d.groups = d.groups.filter((g) => g.kind === 'subscription' || g.id === 'default' || d.profiles.some((p) => p.groupId === g.id))
    save()
    broadcast()
    return { groups: res.groups.length, profiles: n }
  })
  h('update:check', () => checkUpdates(true))
  h('update:download', () => startDownload())
  h('update:install', () => installUpdate())
  h('open:url', (url: string) => {
    if (!/^https:\/\/(github\.com|t\.me)\//.test(url)) throw new Error('Ссылка не разрешена')
    return shell.openExternal(url)
  })
  h('core:proxies', async () => (core.running ? core.proxies() : {}))
  h('admin:relaunch', async () => {
    await disconnect()
    save(true)
    return relaunchAsAdmin()
  })
  h('core:version', () => coreVersion())
  h('open:data', () => shell.openPath(app.getPath('userData')))
  h('win:min', () => win?.minimize())
  h('win:max', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()))
  h('win:close', () => win?.close())
}

// ───────── старт ─────────

app.on('second-instance', showWindow)
app.on('will-quit', () => globalShortcut.unregisterAll())

app.whenReady().then(async () => {
  const d = db()
  if (d.corePid) {
    // Ядро пережило падение приложения — добиваем, иначе порты заняты.
    try {
      const out = execFileSync(sys('tasklist.exe'), ['/FI', `PID eq ${d.corePid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf-8', windowsHide: true })
      if (/sing-box\.exe/i.test(out)) execFileSync(sys('taskkill.exe'), ['/PID', String(d.corePid), '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      /* уже нет */
    }
    d.corePid = undefined
  }
  if (d.dirty) {
    // Прошлый запуск упал с включённым системным прокси.
    await clearSystemProxy(d.settings.mixedPort).catch(() => {})
    d.dirty = false
    save()
  }
  ipc()

  core.on('status', (st: { state: string; error?: string }) => {
    if (st.state !== 'running') void updateNetProxy().catch(() => {})
    if (st.state === 'error' && st.error?.startsWith('Ядро неожиданно')) onCoreCrash()
    broadcast()
  })
  core.on('pid', (pid?: number) => {
    db().corePid = pid
    save(true)
  })
  core.on('log', (l) => send('log', l))
  core.on('traffic', (t: { up: number; down: number }) => {
    addTraffic(core.status.profileId, t.up, t.down)
    send('traffic', t)
  })
  setInterval(() => {
    if (core.running) save()
  }, 30_000)
  // Пока работаем, раз в 5 секунд отдаём свежую статистику в окно.
  setInterval(() => {
    if (core.running) broadcast()
  }, 5_000)

  tray = new Tray(nativeImage.createFromPath(iconPath('tray-off.png')))
  tray.on('click', showWindow)
  updateTray()

  const hidden = process.argv.includes('--hidden') || d.settings.startMinimized
  createWindow(!hidden)
  scheduleSubscriptions()
  registerHotkey()
  // Обновления: через 10 секунд после старта и дальше раз в 6 часов.
  setTimeout(() => void checkUpdates().catch(() => {}), 10_000)
  setInterval(() => void checkUpdates().catch(() => {}), 6 * 3600_000)

  if (d.settings.connectOnLaunch && d.profiles.length) void connect().catch(() => {})
})

app.on('before-quit', (e) => {
  quitting = true
  if (core.status.state !== 'stopped' && core.status.state !== 'error') {
    e.preventDefault()
    void serial(() => core.stop()).finally(() => {
      db().dirty = false
      save(true)
      app.exit(0)
    })
  } else save(true)
})

app.on('window-all-closed', () => {
  /* живём в трее */
})

