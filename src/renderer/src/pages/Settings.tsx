import { useEffect, useState } from 'react'
import { FolderOpen, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { Settings } from '@shared/types'
import { act, AppState, call } from '../api'
import { NumberInput, Row, Segmented, TextInput, Toggle } from '../components/ui'

const ACCENTS = ['#7c5cff', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e', '#ec4899']

export default function SettingsPage({ st }: { st: AppState }): React.JSX.Element {
  const s = st.settings
  const set = (p: Partial<Settings>): void => void act(call('settings', p))
  const [core, setCore] = useState('…')
  useEffect(() => void call<string>('core:version').then(setCore), [])

  return (
    <div className="settings">
      <section className={`card admin-card ${st.isAdmin ? 'ok' : ''}`}>
        {st.isAdmin ? <ShieldCheck size={22} /> : <ShieldAlert size={22} />}
        <div>
          <div className="row-title">{st.isAdmin ? 'Запущено от администратора' : 'Обычные права'}</div>
          <div className="row-hint">
            {st.isAdmin
              ? 'Режим TUN доступен. Автозапуск будет через планировщик задач — без окна UAC при входе.'
              : 'Без прав администратора TUN недоступен. Нажми кнопку справа — Windows спросит один раз, дальше права будут всегда.'}
          </div>
        </div>
        {!st.isAdmin && <button className="btn primary" onClick={() => void act(call('admin:relaunch'))}>Перезапустить от администратора</button>}
      </section>
      <section className="card">
        <Row title="Всегда запускать с правами администратора" hint="Windows спросит разрешение один раз. Потом Orbita запускается с правами через планировщик задач, без окна UAC, и TUN доступен сразу.">
          <Toggle checked={s.runAsAdmin} onChange={(v) => set({ runAsAdmin: v })} />
        </Row>
      </section>

      <section className="card">
        <div className="card-label">Запуск</div>
        <Row title="Запускать вместе с Windows"><Toggle checked={s.launchOnStartup} onChange={(v) => set({ launchOnStartup: v })} /></Row>
        <Row title="Запускать свёрнутой в трей"><Toggle checked={s.startMinimized} onChange={(v) => set({ startMinimized: v })} /></Row>
        <Row title="Подключаться при запуске" hint="К последнему выбранному серверу в последнем режиме"><Toggle checked={s.connectOnLaunch} onChange={(v) => set({ connectOnLaunch: v })} /></Row>
        <Row title="Крестик сворачивает в трей"><Toggle checked={s.closeToTray} onChange={(v) => set({ closeToTray: v })} /></Row>
      </section>

      <section className="card">
        <div className="card-label">Внешний вид</div>
        <Row title="Тема">
          <Segmented value={s.theme} onChange={(v) => set({ theme: v })} options={[{ value: 'dark', label: 'Тёмная' }, { value: 'light', label: 'Светлая' }, { value: 'system', label: 'Как в системе' }]} />
        </Row>
        <Row title="Акцент">
          <div className="accents">
            {ACCENTS.map((c) => (
              <button key={c} className={`accent-dot ${s.accent === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set({ accent: c })} aria-label={c} />
            ))}
          </div>
        </Row>
      </section>

      <section className="card">
        <div className="card-label">Входящие</div>
        <Row title="Порт SOCKS5/HTTP" hint={`127.0.0.1:${s.mixedPort} — один порт для обоих протоколов`}><NumberInput value={s.mixedPort} min={1024} max={65535} onChange={(v) => set({ mixedPort: v })} /></Row>
        <Row title="Разрешить подключения из локальной сети" hint="Телефон или приставка в той же Wi-Fi смогут ходить через этот компьютер"><Toggle checked={s.allowLan} onChange={(v) => set({ allowLan: v })} /></Row>
      </section>

      <section className="card">
        <div className="card-label">TUN</div>
        <Row title="Сетевой стек" hint="mixed — TCP через систему, UDP через gVisor. Если что-то не работает, попробуй gvisor.">
          <Segmented value={s.tunStack} onChange={(v) => set({ tunStack: v })} options={[{ value: 'mixed', label: 'mixed' }, { value: 'system', label: 'system' }, { value: 'gvisor', label: 'gvisor' }]} />
        </Row>
        <Row title="MTU"><NumberInput value={s.tunMtu} min={1280} max={65535} onChange={(v) => set({ tunMtu: v })} /></Row>
        <Row title="Строгий маршрут" hint="Не даёт трафику утечь мимо туннеля, но может мешать локальной сети"><Toggle checked={s.tunStrictRoute} onChange={(v) => set({ tunStrictRoute: v })} /></Row>
        <Row title="IPv6"><Toggle checked={s.ipv6} onChange={(v) => set({ ipv6: v })} /></Row>
      </section>

      <section className="card">
        <div className="card-label">DNS и проверки</div>
        <Row title="DNS через сервер" hint="https://, tls://, udp:// или просто IP"><TextInput value={s.dnsRemote} onChange={(v) => set({ dnsRemote: v })} wide /></Row>
        <Row title="DNS напрямую" hint="Для российских сайтов и адресов самих серверов"><TextInput value={s.dnsDirect} onChange={(v) => set({ dnsDirect: v })} wide /></Row>
        <Row title="Адрес для замера задержки"><TextInput value={s.testUrl} onChange={(v) => set({ testUrl: v })} wide /></Row>
        <Row title="Подробность логов">
          <Segmented value={s.logLevel} onChange={(v) => set({ logLevel: v })} options={[{ value: 'debug', label: 'debug' }, { value: 'info', label: 'info' }, { value: 'warn', label: 'warn' }, { value: 'error', label: 'error' }]} />
        </Row>
      </section>

      <section className="card">
        <div className="card-label">О программе</div>
        <Row title={`Orbita ${st.version}`} hint={`Ядро sing-box ${core}`}>
          <button className="btn" onClick={() => void call('open:data')}><FolderOpen size={15} /> Папка с данными</button>
        </Row>
      </section>
    </div>
  )
}
