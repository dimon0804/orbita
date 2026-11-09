import { useEffect, useState } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts'
import {
  ArrowDown, ArrowUp, ChevronRight, Clock, Globe2, Laptop, Layers, Power, RefreshCw, ShieldAlert, ShieldCheck, Waypoints, Zap
} from 'lucide-react'
import type { ConnectMode, RouteMode } from '@shared/types'
import {
  act, AppState, bytes, stripFlag, call, duration, flag, latencyClass, nameFlag, protoLabel, rate, session, speed, toast, useNow, useStore
} from '../api'
import { Segmented } from '../components/ui'
import { UpdateCard } from './About'
import type { PageId } from '../App'

interface IpInfo {
  ip?: string
  country?: string
  country_code?: string
  city?: string
  connection?: { isp?: string }
}

export default function Dashboard({ st, go }: { st: AppState; go: (p: PageId) => void }): React.JSX.Element {
  const { settings: s, status } = st
  const running = status.state === 'running'
  const busy = status.state === 'starting' || status.state === 'stopping'
  const sp = useStore(speed)
  const sess = useStore(session)
  const now = useNow()
  const [ip, setIp] = useState<IpInfo | null>(null)
  const [ipLoading, setIpLoading] = useState(false)

  const selId = running ? status.profileId : s.selectedProfileId
  const isAuto = Boolean(selId?.startsWith('auto:'))
  const [autoNow, setAutoNow] = useState<string | null>(null)
  useEffect(() => {
    if (!isAuto || !running) return setAutoNow(null)
    const tick = (): void =>
      void call<Record<string, { now?: string }>>('core:proxies').then((p) => setAutoNow(p.auto?.now ?? null)).catch(() => {})
    tick()
    const i = setInterval(tick, 5000)
    return () => clearInterval(i)
  }, [isAuto, running])
  const prof = isAuto
    ? st.profiles.find((p) => p.id === autoNow)
    : (st.profiles.find((p) => p.id === selId) ?? st.profiles[0])
  const group = st.groups.find((g) => g.id === (isAuto ? selId!.slice(5) : prof?.groupId))
  const last = sp[sp.length - 1]
  const today = st.stats.find((x) => x.date === new Date().toISOString().slice(0, 10))

  const loadIp = async (): Promise<void> => {
    setIpLoading(true)
    try {
      setIp(await call<IpInfo>('ip'))
    } catch {
      setIp(null)
    }
    setIpLoading(false)
  }
  useEffect(() => {
    const t = setTimeout(() => void loadIp(), running ? 900 : 100)
    return () => clearTimeout(t)
  }, [running, status.profileId])

  const toggle = async (): Promise<void> => {
    if (busy) return
    if (running) await act(call('disconnect'))
    else {
      if (!st.profiles.length) {
        toast('info', 'Сначала добавь сервер или подписку')
        go('servers')
        return
      }
      await act(call('connect'))
    }
  }

  const modes: { value: ConnectMode; label: string; icon: React.ReactNode; hint: string; disabled?: boolean }[] = [
    { value: 'system', label: 'Системный', icon: <Laptop size={15} />, hint: 'Браузеры и большинство программ идут через прокси Windows' },
    { value: 'tun', label: 'TUN', icon: <Layers size={15} />, hint: 'Виртуальный адаптер: перехватывается трафик всех программ, игр и UDP' },
    { value: 'proxy', label: 'Порт', icon: <Waypoints size={15} />, hint: `Ядро слушает 127.0.0.1:${s.mixedPort}, ничего в системе не меняется` }
  ]
  const routes: { value: RouteMode; label: string; hint: string }[] = [
    { value: 'rule', label: 'По правилам', hint: 'Российские сайты напрямую, остальное через сервер' },
    { value: 'global', label: 'Глобально', hint: 'Весь трафик через прокси' },
    { value: 'direct', label: 'Напрямую', hint: 'Ядро работает, но всё идёт мимо прокси' }
  ]

  const max = Math.max(1024 * 64, ...sp.map((p) => Math.max(p.up, p.down)))

  return (
    <div className="dash">
      {st.update?.available && <div className="dash-update"><UpdateCard st={st} compact /></div>}
      <section className={`hero card ${running ? 'hero-on' : ''} ${busy ? 'hero-busy' : ''}`}>
        <div className="hero-orb-wrap">
          <button className="orb" onClick={() => void toggle()} disabled={busy} aria-label={running ? 'Отключиться' : 'Подключиться'}>
            <span className="orb-ring r1" />
            <span className="orb-ring r2" />
            <span className="orb-core">
              <Power size={38} strokeWidth={2.2} />
            </span>
          </button>
        </div>
        <div className="hero-info">
          <div className="hero-state">
            {status.state === 'starting' ? 'Подключаюсь…' : status.state === 'stopping' ? 'Отключаюсь…' : running ? 'Защищено' : 'Не подключено'}
          </div>
          {running && status.startedAt ? (
            <div className="hero-sub"><Clock size={14} /> {duration(now - status.startedAt)}</div>
          ) : st.killSwitchActive && !busy ? (
            <div className="hero-sub hero-err">
              <ShieldAlert size={14} /> Kill switch закрыл интернет, пока нет подключения.{' '}
              <button className="link-btn" onClick={() => void act(call('disconnect'), 'Интернет снова открыт')}>Открыть</button>
            </div>
          ) : status.state === 'error' ? (
            <div className="hero-sub hero-err">{status.error}</div>
          ) : (
            <div className="hero-sub">Нажми на кнопку, чтобы подключиться</div>
          )}

          <button className="server-pick" onClick={() => go('servers')}>
            <span className="server-flag">{isAuto && !prof ? <Zap size={20} /> : ((prof && nameFlag(prof.name)) ?? '🛰️')}</span>
            <span className="server-text">
              <span className="server-name">
                {isAuto ? `Авто · ${group?.name ?? ''}` : prof ? stripFlag(prof.name) : 'Сервер не выбран'}
              </span>
              <span className="server-meta">
                {isAuto && !prof ? (
                  'Лучший сервер группы по задержке, переключается сам'
                ) : prof ? (
                  <>
                    <span className="proto">{protoLabel(prof.outbound)}</span>
                    {isAuto ? stripFlag(prof.name) : group?.name}
                    {prof.latency !== undefined && (
                      <span className={`lat ${latencyClass(prof.latency)}`}>{prof.latency === null ? 'нет ответа' : `${prof.latency} мс`}</span>
                    )}
                  </>
                ) : (
                  'Добавь сервер, подписку или импортируй из NekoBox'
                )}
              </span>
            </span>
            <ChevronRight size={18} />
          </button>
        </div>
      </section>

      <section className="card modes">
        <div className="card-label">Режим подключения</div>
        <Segmented
          value={s.connectMode}
          options={modes.map((m) => ({ ...m, disabled: m.value === 'tun' && !st.isAdmin }))}
          onChange={(m) => void act(call('mode', m))}
        />
        {!st.isAdmin && (
          <div className="admin-hint">
            <ShieldCheck size={15} />
            <span>TUN ловит трафик всех программ, но ему нужны права администратора.</span>
            <button className="link-btn" onClick={() => void act(call('admin:relaunch'))}>Перезапустить от администратора</button>
          </div>
        )}
        <div className="mode-desc muted small">{modes.find((m) => m.value === s.connectMode)?.hint}</div>
        <div className="card-label" style={{ marginTop: 16 }}>Маршрутизация</div>
        <Segmented value={s.routeMode} options={routes} onChange={(m) => void act(call('settings', { routeMode: m }))} />
      </section>

      <section className="card chart-card">
        <div className="chart-head">
          <div className="speed">
            <span className="speed-dl"><ArrowDown size={15} /> {rate(last.down)}</span>
            <span className="speed-ul"><ArrowUp size={15} /> {rate(last.up)}</span>
          </div>
          <span className="muted">последние 90 секунд</span>
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sp} margin={{ top: 6, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="gDown" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.45} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gUp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--up)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--up)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <YAxis hide domain={[0, max * 1.15]} />
              <Tooltip
                cursor={{ stroke: 'var(--line-strong)' }}
                contentStyle={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12 }}
                labelFormatter={() => ''}
                formatter={(v, n) => [rate(Number(v)), n === 'down' ? 'Загрузка' : 'Отдача']}
              />
              <Area type="monotone" dataKey="down" stroke="var(--accent)" strokeWidth={2} fill="url(#gDown)" isAnimationActive={false} />
              <Area type="monotone" dataKey="up" stroke="var(--up)" strokeWidth={1.6} fill="url(#gUp)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="tiles">
        <Tile icon={<ArrowDown size={16} />} label="Скачано за сеанс" value={bytes(sess.down)} />
        <Tile icon={<ArrowUp size={16} />} label="Отдано за сеанс" value={bytes(sess.up)} />
        <Tile icon={<Zap size={16} />} label="Сегодня всего" value={bytes((today?.up ?? 0) + (today?.down ?? 0))} />
        <div className="tile card ip-tile">
          <div className="tile-label">
            <Globe2 size={16} /> Внешний IP
            <button className="icon-btn sm" onClick={() => void loadIp()} aria-label="Обновить" disabled={ipLoading}>
              <RefreshCw size={13} className={ipLoading ? 'spin' : ''} />
            </button>
          </div>
          <div className="tile-value ip">{ip?.ip ? <>{flag(ip.country_code)} {ip.ip}</> : ipLoading ? '…' : '—'}</div>
          <div className="tile-sub">{ip?.ip ? [ip.city, ip.country].filter(Boolean).join(', ') + (ip.connection?.isp ? ` · ${ip.connection.isp}` : '') : 'не удалось определить'}</div>
        </div>
      </section>
    </div>
  )
}

function Tile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }): React.JSX.Element {
  return (
    <div className="tile card">
      <div className="tile-label">{icon} {label}</div>
      <div className="tile-value">{value}</div>
    </div>
  )
}
