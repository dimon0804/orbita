import { useEffect, useState } from 'react'
import { Download, ExternalLink, RefreshCw, Send, Sparkles } from 'lucide-react'
import { act, AppState, call, toast } from '../api'
import { Logo } from '../components/Logo'

function Github({ size = 16 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  )
}

const TG = 'https://t.me/dimon0804'
const GH = 'https://github.com/dimon0804/orbita'

export default function About({ st }: { st: AppState }): React.JSX.Element {
  const [core, setCore] = useState('…')
  const [checking, setChecking] = useState(false)
  useEffect(() => void call<string>('core:version').then(setCore), [])

  const check = async (): Promise<void> => {
    setChecking(true)
    const r = await act(call<{ available: boolean; latest: string }>('update:check'))
    setChecking(false)
    if (r && !r.available) toast('ok', `У тебя последняя версия — ${st.version}`)
  }
  const open = (url: string): void => void act(call('open:url', url))

  return (
    <div className="about">
      <section className="card about-hero">
        <div className="about-logo"><Logo size={56} on /></div>
        <div>
          <h1>Orbita</h1>
          <div className="muted">Десктопный клиент для прокси и VPN на ядре sing-box</div>
          <div className="about-ver">
            <span className="pill">версия {st.version}{st.portable ? ' · портативная' : ''}</span>
            <span className="pill">sing-box {core}</span>
          </div>
        </div>
      </section>

      <UpdateCard st={st} />

      <section className="card about-actions">
        <button className="btn" onClick={() => void check()} disabled={checking}>
          <RefreshCw size={15} className={checking ? 'spin' : ''} /> {checking ? 'Проверяю…' : 'Проверить обновления'}
        </button>
        <button className="btn" onClick={() => open(GH + '/releases')}><Sparkles size={15} /> Что нового</button>
      </section>

      <section className="card links">
        <div className="card-label">Автор и проект</div>
        <button className="link-row" onClick={() => open(TG)}>
          <span className="link-ic tg"><Send size={17} /></span>
          <span className="link-text"><b>Telegram</b><span className="muted">@dimon0804 — вопросы, идеи, баги</span></span>
          <ExternalLink size={15} className="muted" />
        </button>
        <button className="link-row" onClick={() => open(GH)}>
          <span className="link-ic gh"><Github size={17} /></span>
          <span className="link-text"><b>GitHub</b><span className="muted">dimon0804/orbita — исходники и релизы</span></span>
          <ExternalLink size={15} className="muted" />
        </button>
        <button className="link-row" onClick={() => open(GH + '/issues')}>
          <span className="link-ic"><ExternalLink size={17} /></span>
          <span className="link-text"><b>Сообщить о проблеме</b><span className="muted">GitHub Issues</span></span>
          <ExternalLink size={15} className="muted" />
        </button>
      </section>

      <p className="muted small about-foot">
        © 2026 dimon0804 · MIT. Ядро sing-box — GPL-3.0, флаги — Twemoji (CC-BY 4.0).
        <br />Горячая клавиша подключения: <b>{st.settings.hotkey || 'выключена'}</b>
      </p>
    </div>
  )
}

export function UpdateCard({ st, compact }: { st: AppState; compact?: boolean }): React.JSX.Element | null {
  const u = st.update
  if (!u?.available) return null
  const pct = Math.round((u.progress ?? 0) * 100)
  return (
    <section className={`card update-card ${compact ? 'compact' : ''}`}>
      <div className="update-ic"><Download size={18} /></div>
      <div className="update-text">
        <b>Доступна Orbita {u.latest}</b>
        <span className="muted">
          {u.stage === 'downloading' ? `Скачиваю… ${pct}%` : u.stage === 'ready' ? 'Скачано. Установка займёт несколько секунд, приложение перезапустится.' : u.stage === 'error' ? `Ошибка: ${u.error}` : `у тебя ${u.current}`}
        </span>
        {u.stage === 'downloading' && <div className="quota-bar update-bar"><span style={{ width: `${pct}%` }} /></div>}
        {!compact && u.notes && u.stage !== 'downloading' && <pre className="update-notes">{u.notes.slice(0, 600)}</pre>}
      </div>
      {u.stage === 'ready' ? (
        <button className="btn primary" onClick={() => void act(call('update:install'))}>Установить и перезапустить</button>
      ) : (
        <button className="btn primary" disabled={u.stage === 'downloading'} onClick={() => void act(call('update:download'))}>
          {st.portable ? 'Открыть страницу' : u.stage === 'error' ? 'Повторить' : 'Скачать'}
        </button>
      )}
    </section>
  )
}
