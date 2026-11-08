import { useEffect, useMemo, useState } from 'react'
import {
  ArrowDownUp, Check, ClipboardPaste, Download, FolderPlus, Gauge, Link2, Pencil, Plus, RefreshCw, Rss, Search, Server, Share2, Trash2
} from 'lucide-react'
import type { Group, Profile } from '@shared/types'
import { act, AppState, bytes, call, latencyClass, nameFlag, protoLabel, toast } from '../api'
import { Empty, Modal } from '../components/ui'

type Sort = 'order' | 'latency' | 'name'

export default function Servers({ st }: { st: AppState }): React.JSX.Element {
  const selId = st.status.state === 'running' ? st.status.profileId : st.settings.selectedProfileId
  const selProfile = st.profiles.find((p) => p.id === selId)
  const [groupId, setGroupId] = useState<string>(
    selProfile?.groupId ?? st.groups.find((g) => st.profiles.some((p) => p.groupId === g.id))?.id ?? st.groups[0]?.id ?? 'default'
  )
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>('order')
  const [testing, setTesting] = useState(false)
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [dialog, setDialog] = useState<null | 'add' | 'neko' | 'group' | { edit: Profile } | { editGroup: Group }>(null)

  const group = st.groups.find((g) => g.id === groupId) ?? st.groups[0]
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of st.profiles) m.set(p.groupId, (m.get(p.groupId) ?? 0) + 1)
    return m
  }, [st.profiles])

  const list = useMemo(() => {
    let l = st.profiles.filter((p) => p.groupId === group?.id)
    if (q.trim()) {
      const s = q.toLowerCase()
      l = l.filter((p) => p.name.toLowerCase().includes(s) || String(p.outbound.server ?? '').includes(s) || p.outbound.type.includes(s))
    }
    if (sort === 'latency') l = [...l].sort((a, b) => (a.latency ?? 1e9) - (b.latency ?? 1e9))
    if (sort === 'name') l = [...l].sort((a, b) => a.name.localeCompare(b.name))
    return l
  }, [st.profiles, group?.id, q, sort])

  const test = async (): Promise<void> => {
    setTesting(true)
    await act(call('latency', list.map((p) => p.id)))
    setTesting(false)
  }

  const refresh = async (g: Group): Promise<void> => {
    setRefreshing(g.id)
    await act(call<number>('group:refresh', g.id), (n) => `Подписка обновлена: ${n} серверов`)
    setRefreshing(null)
  }

  const fromClipboard = async (): Promise<void> => {
    const r = await act(call<{ added: number; group?: string }>('add:clipboard', group?.kind === 'manual' ? group.id : undefined))
    if (!r) return
    if (!r.added) toast('warn', 'В буфере обмена не нашлось ссылок на серверы')
    else {
      toast('ok', `Добавлено серверов: ${r.added}`)
      if (r.group) setGroupId(r.group)
    }
  }

  const info = group?.info
  const used = info ? info.upload + info.download : 0

  return (
    <div className="servers">
      <aside className="groups card">
        <div className="groups-head">
          <span className="card-label">Группы</span>
          <button className="icon-btn" onClick={() => setDialog('group')} title="Новая группа"><FolderPlus size={15} /></button>
        </div>
        <div className="groups-list">
          {st.groups.map((g) => (
            <button key={g.id} className={`group-item ${g.id === group?.id ? 'active' : ''}`} onClick={() => setGroupId(g.id)}>
              {g.kind === 'subscription' ? <Rss size={15} /> : <Server size={15} />}
              <span className="group-name">{g.name}</span>
              <span className="group-count">{counts.get(g.id) ?? 0}</span>
            </button>
          ))}
        </div>
        <button className="btn ghost wide" onClick={() => setDialog('neko')}><Download size={15} /> Импорт из NekoBox</button>
      </aside>

      <section className="profiles">
        <div className="toolbar">
          <div className="search">
            <Search size={15} />
            <input placeholder="Поиск по имени, адресу, протоколу" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="btn" onClick={() => void fromClipboard()} title="Ссылки vless://, ss://, hy2:// … или адрес подписки">
            <ClipboardPaste size={15} /> Из буфера
          </button>
          <button className="btn primary" onClick={() => setDialog('add')}><Plus size={15} /> Добавить</button>
        </div>

        {group && (
          <div className="group-bar">
            <div className="group-title">
              <h2>{group.name}</h2>
              {group.kind === 'subscription' && (
                <span className="muted">
                  {group.updatedAt ? `обновлено ${new Date(group.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}` : 'ещё не обновлялась'}
                </span>
              )}
            </div>
            {info && (info.total > 0 || info.expire > 0) && (
              <div className="quota">
                {info.total > 0 && (
                  <>
                    <div className="quota-bar"><span style={{ width: `${Math.min(100, (used / info.total) * 100)}%` }} /></div>
                    <span>{bytes(used)} из {bytes(info.total)}</span>
                  </>
                )}
                {info.total === 0 && <span>израсходовано {bytes(used)}</span>}
                {info.expire > 0 && <span className="muted">до {new Date(info.expire * 1000).toLocaleDateString('ru-RU')}</span>}
              </div>
            )}
            <div className="group-actions">
              <button className="btn ghost sm" onClick={() => setSort(sort === 'latency' ? 'order' : sort === 'order' ? 'name' : 'latency')} title="Сортировка">
                <ArrowDownUp size={14} /> {sort === 'latency' ? 'по задержке' : sort === 'name' ? 'по имени' : 'как есть'}
              </button>
              <button className="btn ghost sm" disabled={testing || !list.length} onClick={() => void test()}>
                <Gauge size={14} className={testing ? 'spin' : ''} /> {testing ? 'Меряю…' : 'Задержка'}
              </button>
              {group.kind === 'subscription' && (
                <button className="btn ghost sm" disabled={refreshing === group.id} onClick={() => void refresh(group)}>
                  <RefreshCw size={14} className={refreshing === group.id ? 'spin' : ''} /> Обновить
                </button>
              )}
              <button className="btn ghost sm" onClick={() => setDialog({ editGroup: group })}><Pencil size={14} /></button>
            </div>
          </div>
        )}

        {list.length === 0 ? (
          <Empty
            icon={<Server size={28} />}
            title={q ? 'Ничего не нашлось' : 'Здесь пока пусто'}
            text={q ? undefined : 'Скопируй ссылку vless://, trojan://, ss://, hy2://, socks5:// или адрес подписки и нажми «Из буфера».'}
          >
            {!q && (
              <>
                <button className="btn primary" onClick={() => void fromClipboard()}><ClipboardPaste size={15} /> Из буфера</button>
                <button className="btn" onClick={() => setDialog('neko')}><Download size={15} /> Импорт из NekoBox</button>
              </>
            )}
          </Empty>
        ) : (
          <div className="plist">
            {list.map((p) => (
              <ProfileRow
                key={p.id}
                p={p}
                selected={p.id === selId}
                running={st.status.state === 'running' && st.status.profileId === p.id}
                onSelect={() => void act(call('select', p.id))}
                onConnect={() => void act(call('select', p.id).then(() => st.status.state !== 'running' && call('connect')))}
                onEdit={() => setDialog({ edit: p })}
              />
            ))}
          </div>
        )}
      </section>

      {dialog === 'add' && <AddDialog groupId={group?.kind === 'manual' ? group.id : undefined} onClose={() => setDialog(null)} onGroup={setGroupId} />}
      {dialog === 'neko' && <NekoDialog onClose={() => setDialog(null)} />}
      {dialog === 'group' && <GroupDialog onClose={() => setDialog(null)} onCreated={setGroupId} />}
      {dialog && typeof dialog === 'object' && 'edit' in dialog && <EditDialog p={dialog.edit} onClose={() => setDialog(null)} />}
      {dialog && typeof dialog === 'object' && 'editGroup' in dialog && (
        <GroupEditDialog g={dialog.editGroup} onClose={() => setDialog(null)} onDeleted={() => setGroupId(st.groups[0]?.id)} />
      )}
    </div>
  )
}

function ProfileRow({ p, selected, running, onSelect, onConnect, onEdit }: {
  p: Profile; selected: boolean; running: boolean; onSelect: () => void; onConnect: () => void; onEdit: () => void
}): React.JSX.Element {
  const flag = nameFlag(p.name)
  const name = flag ? p.name.replace(flag, '').trim() : p.name
  const addr = `${String(p.outbound.server ?? '')}${p.outbound.server_port ? ':' + p.outbound.server_port : ''}`
  const traffic = p.traffic ? p.traffic.up + p.traffic.down : 0
  return (
    <div className={`prow ${selected ? 'selected' : ''} ${running ? 'live' : ''}`} onClick={onSelect} onDoubleClick={onConnect}>
      <span className="prow-flag">{flag ?? <Server size={16} />}</span>
      <div className="prow-main">
        <div className="prow-name">{name}{running && <span className="live-dot" />}</div>
        <div className="prow-addr">{addr}</div>
      </div>
      <span className="proto">{protoLabel(p.outbound)}</span>
      <span className="prow-traffic">{traffic ? bytes(traffic) : ''}</span>
      <span className={`lat ${latencyClass(p.latency)}`}>{p.latency === undefined ? '—' : p.latency === null ? 'тайм-аут' : `${p.latency} мс`}</span>
      <div className="prow-actions" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn" title="Скопировать ссылку" onClick={() => void act(call('profile:link', p.id), 'Ссылка скопирована')}><Share2 size={14} /></button>
        <button className="icon-btn" title="Изменить" onClick={onEdit}><Pencil size={14} /></button>
        <button className="icon-btn danger" title="Удалить" onClick={() => void act(call('profile:delete', [p.id]), 'Удалено')}><Trash2 size={14} /></button>
      </div>
      {selected && <Check size={16} className="prow-check" />}
    </div>
  )
}

function AddDialog({ groupId, onClose, onGroup }: { groupId?: string; onClose: () => void; onGroup: (id: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const isSub = /^https?:\/\/\S+$/i.test(text.trim()) && !/^https?:\/\/[^@/]+@/.test(text.trim())
  const submit = async (): Promise<void> => {
    setBusy(true)
    const r = await act(call<{ added: number; group?: string }>('add:text', text, groupId))
    setBusy(false)
    if (!r) return
    if (!r.added) return toast('warn', 'Не нашёл ни одного сервера. Проверь ссылку.')
    toast('ok', isSub ? `Подписка добавлена: ${r.added} серверов` : `Добавлено серверов: ${r.added}`)
    if (r.group) onGroup(r.group)
    onClose()
  }
  return (
    <Modal title="Добавить сервер или подписку" onClose={onClose}>
      <p className="muted">
        Вставь одну или несколько ссылок (каждая с новой строки) или адрес подписки. Понимаю VLESS, Reality, VMess, Trojan, Shadowsocks,
        Hysteria 2, TUIC, AnyTLS, SOCKS4/5, HTTP и HTTPS, а также подписки base64, Clash и sing-box.
      </p>
      <textarea
        className="input area"
        autoFocus
        rows={7}
        placeholder={'vless://…\nhy2://…\nsocks5://user:pass@1.2.3.4:1080#Мой сокс\nhttps://sub.example.com/abc'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="modal-foot">
        <span className="muted">{text.trim() ? (isSub ? <><Rss size={13} /> это подписка</> : <><Link2 size={13} /> ссылки на серверы</>) : ''}</span>
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!text.trim() || busy} onClick={() => void submit()}>{busy ? 'Загружаю…' : 'Добавить'}</button>
      </div>
    </Modal>
  )
}

function NekoDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [dir, setDir] = useState<string>('')
  const [busy, setBusy] = useState(false)
  useEffect(() => void call<string | null>('neko:detect').then((d) => d && setDir(d)), [])
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = await act(call<{ groups: number; profiles: number }>('neko:import', dir || undefined), (r) => `Импортировано: ${r.profiles} серверов из ${r.groups} групп`)
    setBusy(false)
    if (r) onClose()
  }
  return (
    <Modal title="Импорт из NekoBox / NekoRay" onClose={onClose}>
      <p className="muted">Перенесу группы, подписки и серверы. Сам NekoBox и его файлы не меняются.</p>
      <label className="field">
        <span>Папка config</span>
        <input className="input input-wide" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="C:\…\nekoray\config" />
      </label>
      <p className="muted small">Профили с транспортом xhttp ядро sing-box пока не поддерживает, их пропущу.</p>
      <div className="modal-foot">
        <span />
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={busy || !dir} onClick={() => void run()}>{busy ? 'Импортирую…' : 'Импортировать'}</button>
      </div>
    </Modal>
  )
}

function GroupDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const create = async (): Promise<void> => {
    const id = await act(call<string>('group:add', name.trim()))
    if (id) {
      onCreated(id)
      onClose()
    }
  }
  return (
    <Modal title="Новая группа" onClose={onClose}>
      <input className="input input-wide" autoFocus value={name} placeholder="Например, «Рабочие»" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void create()} />
      <p className="muted small">Чтобы добавить подписку, просто вставь её адрес через «Добавить» — группа создастся сама.</p>
      <div className="modal-foot">
        <span />
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>Создать</button>
      </div>
    </Modal>
  )
}

function GroupEditDialog({ g, onClose, onDeleted }: { g: Group; onClose: () => void; onDeleted: () => void }): React.JSX.Element {
  const [name, setName] = useState(g.name)
  const [url, setUrl] = useState(g.url ?? '')
  const [ua, setUa] = useState(g.userAgent ?? '')
  const [hours, setHours] = useState(g.autoUpdateHours ?? 0)
  const [confirm, setConfirm] = useState(false)
  const saveIt = async (): Promise<void> => {
    await act(call('group:update', g.id, { name, url: url || undefined, userAgent: ua || undefined, autoUpdateHours: hours }), 'Сохранено')
    onClose()
  }
  return (
    <Modal title="Группа" onClose={onClose}>
      <label className="field"><span>Название</span><input className="input input-wide" value={name} onChange={(e) => setName(e.target.value)} /></label>
      {g.kind === 'subscription' && (
        <>
          <label className="field"><span>Адрес подписки</span><input className="input input-wide" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
          <label className="field"><span>User-Agent</span><input className="input input-wide" value={ua} placeholder="авто: sing-box → Clash → v2rayN" onChange={(e) => setUa(e.target.value)} /></label>
          <label className="field"><span>Автообновление, часов (0 — выкл.)</span><input className="input input-num" type="number" min={0} value={hours} onChange={(e) => setHours(Number(e.target.value))} /></label>
        </>
      )}
      <div className="modal-foot">
        {confirm ? (
          <button className="btn danger" onClick={() => void act(call('group:delete', g.id), 'Группа удалена').then(() => { onDeleted(); onClose() })}>
            Точно удалить вместе с серверами
          </button>
        ) : (
          <button className="btn ghost danger-text" onClick={() => setConfirm(true)}><Trash2 size={14} /> Удалить</button>
        )}
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={() => void saveIt()}>Сохранить</button>
      </div>
    </Modal>
  )
}

function EditDialog({ p, onClose }: { p: Profile; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState(p.name)
  const [json, setJson] = useState(JSON.stringify(p.outbound, null, 2))
  const [err, setErr] = useState('')
  const saveIt = async (): Promise<void> => {
    let outbound
    try {
      outbound = JSON.parse(json)
      if (!outbound.type) throw new Error('нет поля type')
    } catch (e) {
      setErr('JSON с ошибкой: ' + (e as Error).message)
      return
    }
    await act(call('profile:update', p.id, { name, outbound }), 'Сохранено')
    onClose()
  }
  return (
    <Modal title="Сервер" onClose={onClose} wide>
      <label className="field"><span>Название</span><input className="input input-wide" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">
        <span>Исходящее соединение (формат sing-box)</span>
        <textarea className="input area mono" rows={14} value={json} spellCheck={false} onChange={(e) => { setJson(e.target.value); setErr('') }} />
      </label>
      {err && <div className="err">{err}</div>}
      <div className="modal-foot">
        <span />
        <button className="btn" onClick={onClose}>Отмена</button>
        <button className="btn primary" onClick={() => void saveIt()}>Сохранить</button>
      </div>
    </Modal>
  )
}
