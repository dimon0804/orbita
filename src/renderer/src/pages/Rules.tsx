import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { RouteRule } from '@shared/types'
import { act, AppState, call } from '../api'
import { Row, Segmented, Toggle } from '../components/ui'

const MATCH: { value: RouteRule['match']; label: string; ph: string }[] = [
  { value: 'domain_suffix', label: 'Домен', ph: 'youtube.com, googlevideo.com' },
  { value: 'domain_keyword', label: 'Слово в домене', ph: 'openai' },
  { value: 'ip_cidr', label: 'IP / подсеть', ph: '91.108.0.0/16' },
  { value: 'process_name', label: 'Программа', ph: 'Discord.exe, Telegram.exe' },
  { value: 'geosite', label: 'Geosite', ph: 'youtube, openai, discord' },
  { value: 'geoip', label: 'GeoIP', ph: 'us, de' }
]

export default function Rules({ st }: { st: AppState }): React.JSX.Element {
  const s = st.settings
  const [draft, setDraft] = useState<Omit<RouteRule, 'id' | 'enabled'>>({ match: 'domain_suffix', value: '', action: 'proxy' })
  const set = (patch: object): void => void act(call('settings', patch))
  const setRules = (rules: RouteRule[]): void => set({ rules })

  const add = (): void => {
    if (!draft.value.trim()) return
    setRules([...s.rules, { ...draft, id: Math.random().toString(36).slice(2, 9), enabled: true }])
    setDraft({ ...draft, value: '' })
  }

  return (
    <div className="rules">
      <section className="card">
        <div className="card-label">Режим</div>
        <Segmented
          value={s.routeMode}
          onChange={(m) => set({ routeMode: m })}
          options={[
            { value: 'rule', label: 'По правилам' },
            { value: 'global', label: 'Всё через сервер' },
            { value: 'direct', label: 'Напрямую' }
          ]}
        />
        {s.routeMode !== 'rule' && <p className="muted small">Правила ниже работают только в режиме «По правилам».</p>}
      </section>

      <section className="card">
        <Row title="Российские сайты напрямую" hint="Домены .ru/.рф/.su, категория geosite ru и российские IP идут мимо сервера. Банки и госуслуги не ругаются.">
          <Toggle checked={s.bypassRu} onChange={(v) => set({ bypassRu: v })} />
        </Row>
        <Row title="Блокировать рекламу" hint="Набор geosite category-ads-all: рекламные и трекинговые домены отбрасываются.">
          <Toggle checked={s.blockAds} onChange={(v) => set({ blockAds: v })} />
        </Row>
      </section>

      <section className="card">
        <div className="card-label">Свои правила · срабатывают сверху вниз, раньше встроенных</div>
        <div className="rule-add">
          <select className="input" value={draft.match} onChange={(e) => setDraft({ ...draft, match: e.target.value as RouteRule['match'] })}>
            {MATCH.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <input
            className="input grow"
            value={draft.value}
            placeholder={MATCH.find((m) => m.value === draft.match)?.ph}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <select className="input" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value as RouteRule['action'] })}>
            <option value="proxy">через сервер</option>
            <option value="direct">напрямую</option>
            <option value="block">блокировать</option>
          </select>
          <button className="btn primary" onClick={add} disabled={!draft.value.trim()}><Plus size={15} /> Добавить</button>
        </div>
        {s.rules.length === 0 && <p className="muted small">Например: «Программа — Discord.exe — через сервер» или «Домен — sberbank.ru — напрямую».</p>}
        <div className="rule-list">
          {s.rules.map((r) => (
            <div className={`rule ${r.enabled ? '' : 'off'}`} key={r.id}>
              <Toggle checked={r.enabled} onChange={(v) => setRules(s.rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)))} />
              <span className="rule-match">{MATCH.find((m) => m.value === r.match)?.label}</span>
              <span className="rule-val">{r.value}</span>
              <span className={`rule-act act-${r.action}`}>{r.action === 'proxy' ? 'через сервер' : r.action === 'direct' ? 'напрямую' : 'блок'}</span>
              <button className="icon-btn danger" onClick={() => setRules(s.rules.filter((x) => x.id !== r.id))}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        <p className="muted small">Правила «Программа» надёжно работают в режиме TUN: системный прокси не знает, какая программа делает запрос.</p>
      </section>
    </div>
  )
}
