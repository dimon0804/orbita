import { useMemo } from 'react'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { AppState, bytes, nameFlag, protoLabel } from '../api'

export default function Stats({ st }: { st: AppState }): React.JSX.Element {
  const days = useMemo(() => {
    const out = []
    const map = new Map(st.stats.map((s) => [s.date, s]))
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000)
      const key = d.toISOString().slice(0, 10)
      const s = map.get(key)
      out.push({ key, label: d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }), up: s?.up ?? 0, down: s?.down ?? 0 })
    }
    return out
  }, [st.stats])

  const sum = (n: number): { up: number; down: number } =>
    days.slice(-n).reduce((a, d) => ({ up: a.up + d.up, down: a.down + d.down }), { up: 0, down: 0 })
  const today = sum(1)
  const week = sum(7)
  const month = sum(30)

  const top = useMemo(
    () =>
      st.profiles
        .filter((p) => p.traffic && p.traffic.up + p.traffic.down > 0)
        .sort((a, b) => b.traffic!.up + b.traffic!.down - (a.traffic!.up + a.traffic!.down))
        .slice(0, 8),
    [st.profiles]
  )
  const topMax = top[0] ? top[0].traffic!.up + top[0].traffic!.down : 1

  return (
    <div className="stats">
      <div className="tiles">
        {[
          ['Сегодня', today],
          ['7 дней', week],
          ['30 дней', month]
        ].map(([l, v]) => {
          const x = v as { up: number; down: number }
          return (
            <div className="tile card" key={l as string}>
              <div className="tile-label">{l as string}</div>
              <div className="tile-value">{bytes(x.up + x.down)}</div>
              <div className="tile-sub">↓ {bytes(x.down)} · ↑ {bytes(x.up)}</div>
            </div>
          )
        })}
        <div className="tile card">
          <div className="tile-label">Серверов</div>
          <div className="tile-value">{st.profiles.length}</div>
          <div className="tile-sub">в {st.groups.length} группах</div>
        </div>
      </div>

      <section className="card">
        <div className="card-label">Трафик по дням</div>
        <div className="bars">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={days} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
              <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted)', fontSize: 11 }} interval={4} />
              <Tooltip
                cursor={{ fill: 'var(--hover)' }}
                contentStyle={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 12 }}
                formatter={(v, n) => [bytes(Number(v)), n === 'down' ? 'Загрузка' : 'Отдача']}
              />
              <Bar dataKey="down" stackId="a" fill="var(--accent)" radius={[0, 0, 0, 0]} />
              <Bar dataKey="up" stackId="a" fill="var(--up)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="card">
        <div className="card-label">Больше всего трафика</div>
        {top.length === 0 && <div className="muted">Статистика по серверам появится после первого подключения.</div>}
        <div className="top">
          {top.map((p) => {
            const t = p.traffic!.up + p.traffic!.down
            return (
              <div className="top-row" key={p.id}>
                <span className="top-name">{nameFlag(p.name) ?? ''} {p.name.replace(nameFlag(p.name) ?? '', '').trim()}</span>
                <span className="proto">{protoLabel(p.outbound)}</span>
                <div className="top-bar"><span style={{ width: `${(t / topMax) * 100}%` }} /></div>
                <span className="top-val">{bytes(t)}</span>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
