import { useEffect, useState } from 'react'
import {
  Activity, BarChart3, Gauge, Info, Minus, Network, ScrollText, Server, Settings2, Shield, Square, X, Copy as Restore
} from 'lucide-react'
import { appState, call, on, startBridge, toasts, useStore } from './api'
import Dashboard from './pages/Dashboard'
import Servers from './pages/Servers'
import Connections from './pages/Connections'
import Logs from './pages/Logs'
import Stats from './pages/Stats'
import Rules from './pages/Rules'
import SettingsPage from './pages/Settings'
import About from './pages/About'
import { Logo } from './components/Logo'

const PAGES = [
  { id: 'home', label: 'Главная', icon: Gauge },
  { id: 'servers', label: 'Серверы', icon: Server },
  { id: 'connections', label: 'Соединения', icon: Network },
  { id: 'rules', label: 'Маршруты', icon: Shield },
  { id: 'stats', label: 'Статистика', icon: BarChart3 },
  { id: 'logs', label: 'Логи', icon: ScrollText },
  { id: 'settings', label: 'Настройки', icon: Settings2 },
  { id: 'about', label: 'О программе', icon: Info }
] as const
export type PageId = (typeof PAGES)[number]['id']

export default function App(): React.JSX.Element {
  const [page, setPage] = useState<PageId>('home')
  const [maximized, setMaximized] = useState(false)
  const st = useStore(appState)
  const list = useStore(toasts)

  useEffect(() => {
    startBridge()
    return on('window', (p) => setMaximized((p as { maximized: boolean }).maximized))
  }, [])

  useEffect(() => {
    const theme = st?.settings.theme ?? 'dark'
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    if (st?.settings.accent) document.documentElement.style.setProperty('--accent', st.settings.accent)
  }, [st?.settings.theme, st?.settings.accent])

  const running = st?.status.state === 'running'

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-brand">
          <Logo size={18} on={running} />
          <span>Orbita</span>
          {st && (
            <span className={`pill ${running ? 'pill-on' : ''}`}>
              <span className="dot" />
              {running ? 'подключено' : st.status.state === 'starting' ? 'запуск…' : 'отключено'}
            </span>
          )}
        </div>
        <div className="titlebar-btns">
          <button onClick={() => void call('win:min')} aria-label="Свернуть"><Minus size={15} /></button>
          <button onClick={() => void call('win:max')} aria-label="Развернуть">
            {maximized ? <Restore size={13} /> : <Square size={12} />}
          </button>
          <button className="close" onClick={() => void call('win:close')} aria-label="Закрыть"><X size={16} /></button>
        </div>
      </header>

      <nav className="sidebar">
        {PAGES.map((p) => (
          <button key={p.id} className={`nav ${page === p.id ? 'active' : ''}`} onClick={() => setPage(p.id)}>
            <p.icon size={18} strokeWidth={1.8} />
            <span>{p.label}</span>
            {p.id === 'about' && st?.update?.available && <span className="nav-dot" title="Есть обновление" />}
          </button>
        ))}
        <div className="sidebar-foot">
          <Activity size={14} />
          <span>v{st?.version ?? '…'}</span>
          {st?.isAdmin && <span className="badge-admin">админ</span>}
        </div>
      </nav>

      <main className="content">
        {!st ? (
          <div className="loading" />
        ) : (
          <div className="page" key={page}>
            {page === 'home' && <Dashboard st={st} go={setPage} />}
            {page === 'servers' && <Servers st={st} />}
            {page === 'connections' && <Connections st={st} />}
            {page === 'rules' && <Rules st={st} />}
            {page === 'stats' && <Stats st={st} />}
            {page === 'logs' && <Logs />}
            {page === 'settings' && <SettingsPage st={st} />}
            {page === 'about' && <About st={st} />}
          </div>
        )}
      </main>

      <div className="toasts">
        {list.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </div>
  )
}
