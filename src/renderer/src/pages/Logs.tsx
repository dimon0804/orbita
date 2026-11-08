import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, Copy, Search, Trash2 } from 'lucide-react'
import type { LogLine } from '@shared/types'
import { act, call, logs, toast, useStore } from '../api'
import { Segmented } from '../components/ui'

type Lvl = 'all' | 'info' | 'warn' | 'error'
const RANK: Record<LogLine['level'], number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 }

export default function Logs(): React.JSX.Element {
  const all = useStore(logs)
  const [lvl, setLvl] = useState<Lvl>('all')
  const [q, setQ] = useState('')
  const [follow, setFollow] = useState(true)
  const box = useRef<HTMLDivElement>(null)

  const list = useMemo(() => {
    const min = lvl === 'all' ? 0 : RANK[lvl]
    const s = q.toLowerCase()
    const l = all.filter((x) => RANK[x.level] >= min && (!s || x.text.toLowerCase().includes(s)))
    return l.slice(-1500)
  }, [all, lvl, q])

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [list, follow])

  const counts = useMemo(() => {
    let w = 0
    let e = 0
    for (const x of all) {
      if (x.level === 'warn') w++
      else if (RANK[x.level] >= 4) e++
    }
    return { w, e }
  }, [all])

  return (
    <div className="logs">
      <div className="toolbar">
        <div className="search">
          <Search size={15} />
          <input placeholder="Поиск по логам" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented<Lvl>
          value={lvl}
          onChange={setLvl}
          options={[
            { value: 'all', label: 'Все' },
            { value: 'info', label: 'Инфо' },
            { value: 'warn', label: `Предупр. ${counts.w || ''}` },
            { value: 'error', label: `Ошибки ${counts.e || ''}` }
          ]}
        />
        <button className={`btn ${follow ? 'primary-soft' : ''}`} onClick={() => setFollow(!follow)} title="Автопрокрутка"><ArrowDownToLine size={15} /></button>
        <button className="btn" title="Скопировать" onClick={() => {
          void navigator.clipboard.writeText(list.map((l) => `${new Date(l.t).toLocaleTimeString('ru-RU')} ${l.text}`).join('\n'))
          toast('ok', `Скопировано строк: ${list.length}`)
        }}><Copy size={15} /></button>
        <button className="btn" title="Очистить" onClick={() => void act(call('logs:clear')).then(() => logs.set([]))}><Trash2 size={15} /></button>
      </div>
      <div
        className="logbox card"
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
          if (atBottom !== follow) setFollow(atBottom)
        }}
      >
        {list.length === 0 && <div className="muted log-empty">Пока тихо. Логи ядра появятся после подключения.</div>}
        {list.map((l, i) => (
          <div key={i} className={`log log-${l.level}`}>
            <span className="log-t">{new Date(l.t).toLocaleTimeString('ru-RU')}</span>
            <span className="log-l">{l.level}</span>
            <span className="log-x">{l.text.replace(/^(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s*/, '')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
