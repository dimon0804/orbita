import { useEffect, useMemo, useState } from 'react'
import { Network, Pause, Play, Search, X, XCircle } from 'lucide-react'
import { act, AppState, bytes, call, duration, useNow } from '../api'
import { Empty } from '../components/ui'

interface Conn {
  id: string
  metadata: {
    network: string
    type: string
    sourceIP: string
    destinationIP: string
    destinationPort: string
    host: string
    processPath?: string
  }
  upload: number
  download: number
  start: string
  chains: string[]
  rule: string
}

export default function Connections({ st }: { st: AppState }): React.JSX.Element {
  const running = st.status.state === 'running'
  const [conns, setConns] = useState<Conn[]>([])
  const [speeds, setSpeeds] = useState<Map<string, number>>(new Map())
  const [paused, setPaused] = useState(false)
  const [q, setQ] = useState('')
  const now = useNow()

  useEffect(() => {
    if (!running || paused) return
    let prev = new Map<string, number>()
    const tick = async (): Promise<void> => {
      try {
        const r = await call<{ connections: Conn[] | null }>('connections')
        const list = r.connections ?? []
        const sp = new Map<string, number>()
        for (const c of list) {
          const total = c.upload + c.download
          sp.set(c.id, prev.has(c.id) ? total - prev.get(c.id)! : 0)
        }
        prev = new Map(list.map((c) => [c.id, c.upload + c.download]))
        setSpeeds(sp)
        setConns(list)
      } catch {
        /* ядро перезапускается */
      }
    }
    void tick()
    const i = setInterval(() => void tick(), 1000)
    return () => clearInterval(i)
  }, [running, paused])

  const names = useMemo(() => new Map(st.profiles.map((p) => [p.id, p.name])), [st.profiles])
  const list = useMemo(() => {
    const s = q.toLowerCase()
    const l = s
      ? conns.filter((c) => (c.metadata.host + c.metadata.destinationIP + (c.metadata.processPath ?? '') + c.rule).toLowerCase().includes(s))
      : conns
    return [...l].sort((a, b) => +new Date(b.start) - +new Date(a.start))
  }, [conns, q])

  if (!running)
    return <Empty icon={<Network size={28} />} title="Ядро не запущено" text="Подключись, и здесь появятся все живые соединения: куда, через что и сколько трафика." />

  const route = (c: Conn): string => {
    const last = c.chains[c.chains.length - 1] ?? ''
    const first = c.chains[0] ?? ''
    if (first === 'direct' || last === 'direct') return 'напрямую'
    return names.get(first) ?? names.get(last) ?? first
  }

  return (
    <div className="conns">
      <div className="toolbar">
        <div className="search">
          <Search size={15} />
          <input placeholder="Фильтр по домену, IP, программе" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="muted">{list.length} соединений</span>
        <button className="btn" onClick={() => setPaused(!paused)}>{paused ? <Play size={15} /> : <Pause size={15} />} {paused ? 'Продолжить' : 'Пауза'}</button>
        <button className="btn danger-text" onClick={() => void act(call('connections:close'), 'Все соединения закрыты')}><XCircle size={15} /> Закрыть все</button>
      </div>
      <div className="table card">
        <div className="tr th">
          <span>Куда</span><span>Программа</span><span>Маршрут</span><span>Скорость</span><span>Трафик</span><span>Время</span><span />
        </div>
        <div className="tbody">
          {list.map((c) => {
            const proc = c.metadata.processPath?.split(/[\\/]/).pop()
            const r = route(c)
            return (
              <div className="tr" key={c.id}>
                <span className="cell-host">
                  <span className={`net net-${c.metadata.network}`}>{c.metadata.network}</span>
                  {c.metadata.host || c.metadata.destinationIP}:{c.metadata.destinationPort}
                </span>
                <span className="muted ellipsis" title={c.metadata.processPath}>{proc || c.metadata.type}</span>
                <span className={`ellipsis ${r === 'напрямую' ? 'muted' : 'accent'}`}>{r}</span>
                <span>{speeds.get(c.id) ? bytes(speeds.get(c.id)!) + '/с' : ''}</span>
                <span>{bytes(c.upload + c.download)}</span>
                <span className="muted">{duration(now - +new Date(c.start))}</span>
                <button className="icon-btn" title="Закрыть" onClick={() => void call('connections:close', c.id)}><X size={14} /></button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
