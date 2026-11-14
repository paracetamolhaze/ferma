"use client";
/** «Аккаунты»: the owner's own Meta apps, the accounts of every profile and the diagnostics of both. */
import { useEffect, useState } from 'react';
import { AlertCircle, Check, ImageUp, Plug, RefreshCw, Stethoscope, Trash2 } from 'lucide-react';
import { CheckList, ErrorLine, FORMAT_NAMES, Loading, send, Spin, useAction, useApi, type Check as CheckRow } from './content-ui';
import { Avatar, formatDate, Modal, Network, StatusPill, type Ctx, type Profile } from './shared';

type ProviderRow = { provider: string; platform: string; name: string; capabilities: { formats: string[]; maxText: number; maxCarousel: number; dailyLimit: number; inactive?: string }; app: { appId: string; redirectUri: string } | null };
type MediaTest = { containerId: string; startedAt: string; state: 'pending' | 'ok' | 'fail'; detail: string };
type AccountRow = { id: string; profileId: string; platform: string; provider: string; username: string | null; accountType: string | null; followers: number | null; status: string; tokenExpiresAt: string | null; lastCheckedAt: string | null; error: string | null; quotaUsed: number | null; quotaTotal: number | null; pausedUntil: string | null; paused: boolean; diagnostics: { at: string; checks: CheckRow[]; mediaTest?: MediaTest | null } | null };
type AppChecks = { apps: { provider: string; checks: CheckRow[] }[]; media: CheckRow };
const ROUTE: Record<string, string> = { meta_threads: 'threads', meta_instagram: 'instagram' };

function AppForm({ ctx, row, base, onSaved }: { ctx: Ctx; row: ProviderRow; base: string | null; onSaved: () => void }) {
  const [appId, setAppId] = useState(row.app?.appId || '');
  const [secret, setSecret] = useState('');
  const [redirect, setRedirect] = useState(row.app?.redirectUri || (base ? `${base.replace(/\/+$/, '')}/oauth/${ROUTE[row.provider]}` : ''));
  const action = useAction(ctx);
  return <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.run('save', async () => { await send('/api/accounts', { action: 'saveApp', provider: row.provider, appId, appSecret: secret || null, redirectUri: redirect }); setSecret(''); onSaved(); }, 'Приложение сохранено.'); }}>
    <label>ID приложения<input required inputMode="numeric" value={appId} onChange={event => setAppId(event.target.value)} /></label>
    <label>Секрет приложения<input type="password" autoComplete="off" value={secret} onChange={event => setSecret(event.target.value)} placeholder={row.app ? 'Сохранён. Введите новый, чтобы заменить' : ''} required={!row.app} /></label>
    <label>Адрес возврата<input required value={redirect} onChange={event => setRedirect(event.target.value)} placeholder={`https://ваш-домен/ferma/oauth/${ROUTE[row.provider]}`} /></label>
    <small className="muted">Этот же адрес добавьте в настройках приложения в кабинете Meta for Developers.</small>
    <ErrorLine text={action.error} />
    <div><button className="ghost" disabled={Boolean(action.busy)}><Spin on={action.busy === 'save'}><Check size={15} /></Spin>Сохранить</button></div>
  </form>;
}

function AccountModal({ ctx, account, profile, close, onChanged }: { ctx: Ctx; account: AccountRow; profile: Profile | undefined; close: () => void; onChanged: () => void }) {
  const action = useAction(ctx);
  const { setError } = action;
  const [diagnostics, setDiagnostics] = useState(account.diagnostics);
  const test = diagnostics?.mediaTest;
  useEffect(() => {
    // Meta needs a few seconds to fetch the picture: the result is read again until it is known.
    if (test?.state !== 'pending') return;
    const timer = setTimeout(() => { void send<MediaTest>('/api/accounts', { action: 'mediaTestStatus', accountId: account.id }).then(result => setDiagnostics(current => current ? { ...current, mediaTest: result } : current)).catch(error => setError(error.message)); }, 5000);
    return () => clearTimeout(timer);
  }, [test, account.id, setError]);
  return <Modal title={`@${account.username} · ${profile?.name || ''}`} close={close} wide>
    <div className="form-body stack">
      <div className="panel-actions">
        <button className="ghost" disabled={Boolean(action.busy)} onClick={() => void action.run('diagnose', async () => { setDiagnostics(await send('/api/accounts', { action: 'diagnose', accountId: account.id })); onChanged(); })}><Spin on={action.busy === 'diagnose'}><Stethoscope size={15} /></Spin>Проверить аккаунт</button>
        <button className="ghost" disabled={Boolean(action.busy) || account.status !== 'connected'} onClick={() => void action.run('media', async () => { const result = await send<MediaTest>('/api/accounts', { action: 'mediaTest', accountId: account.id }); setDiagnostics(current => ({ at: current?.at || new Date().toISOString(), checks: current?.checks || [], mediaTest: result })); })}><Spin on={action.busy === 'media'}><ImageUp size={15} /></Spin>Проверить картинку через Meta</button>
      </div>
      <small className="muted">«Проверить аккаунт» только читает: токен, права, лимит, статистику. «Проверить картинку» просит Meta скачать настоящую карточку в скрытый контейнер: он не публикуется и сам удалится через 24 часа.</small>
      <ErrorLine text={action.error} />
      {diagnostics?.checks.length ? <><p className="muted">Проверено {formatDate(diagnostics.at)}</p><CheckList checks={diagnostics.checks} /></> : <p className="muted">Аккаунт ещё не проверялся.</p>}
      {test && <CheckList checks={[{ key: 'media', label: 'Картинка через Meta', state: test.state === 'pending' ? 'skip' : test.state, detail: test.state === 'pending' ? 'Meta скачивает картинку…' : test.detail }]} />}
    </div>
  </Modal>;
}

export function AccountsView({ ctx }: { ctx: Ctx }) {
  const view = useApi<{ providers: ProviderRow[]; accounts: AccountRow[] }>('/api/accounts', 60000);
  const engine = useApi<{ settings: { publicBaseUrl: string | null } }>('/api/content?view=engine');
  const action = useAction(ctx);
  const [checks, setChecks] = useState<AppChecks | null>(null);
  const [open, setOpen] = useState<AccountRow | null>(null);
  useEffect(() => {
    // The network sent the owner back here: finish the connection once, then clean the address.
    if (!location.hash.startsWith('#accounts/oauth?')) return;
    const fields = new URLSearchParams(location.hash.slice('#accounts/oauth?'.length));
    history.replaceState(null, '', '#accounts');
    const state = fields.get('state'), code = fields.get('code');
    if (fields.get('error') || !state || !code) { action.setError(`Соцсеть не выдала доступ: ${fields.get('error_description') || fields.get('error') || 'нет кода'}.`); return; }
    void action.run('finish', async () => { const result = await send<{ username: string }>('/api/accounts', { action: 'finish', state, code }); await view.reload(); ctx.notify(`Подключён @${result.username}.`); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (view.loading && !view.data) return <Loading />;
  const base = engine.data?.settings.publicBaseUrl || null;
  const accounts = view.data?.accounts || [];
  const providers = (view.data?.providers || []).filter(row => row.provider.startsWith('meta_'));
  const connect = (provider: string, profileId: string) => action.run(provider + profileId, async () => { const { url } = await send<{ url: string }>('/api/accounts', { action: 'connect', provider, profileId }); location.href = url; });
  return <div className="stack">
    <ErrorLine text={view.error || action.error} />
    {action.busy === 'finish' && <Loading text="Завершаем подключение…" />}
    {!base && <p className="notice-bad"><AlertCircle size={15} /><span>Не задан публичный адрес FERMA (Настройки → Публикации). Без него Meta не вернёт вас после входа и не сможет забрать картинки.</span></p>}
    <div className="columns">{providers.map(row => {
      const appChecks = checks?.apps.find(entry => entry.provider === row.provider)?.checks;
      return <section className="panel" key={row.provider}>
        <header className="panel-head"><h2>Приложение Meta для {row.platform === 'threads' ? 'Threads' : 'Instagram'}</h2>{row.app ? <span className="pill good">Сохранено</span> : <span className="pill plain">Не добавлено</span>}</header>
        <div className="panel-body stack">
          <AppForm key={`${row.provider}:${row.app?.redirectUri || ''}:${base || ''}`} ctx={ctx} row={row} base={base} onSaved={() => { setChecks(null); void view.reload(); }} />
          {appChecks && <CheckList checks={appChecks} />}
          <small className="muted">Форматы: {row.capabilities.formats.map(format => FORMAT_NAMES[format] || format).join(', ').toLowerCase()}. Текст до {row.capabilities.maxText} знаков, карусель до {row.capabilities.maxCarousel} картинок, до {row.capabilities.dailyLimit} публикаций в сутки на аккаунт. Публикует сама FERMA в назначенное время: компьютер должен быть включён.</small>
        </div>
      </section>;
    })}</div>
    <section className="panel">
      <header className="panel-head"><h2>Проверка подключения</h2><button className="ghost small" disabled={Boolean(action.busy)} onClick={() => void action.run('apps', async () => setChecks(await send<AppChecks>('/api/accounts', { action: 'diagnoseApps' })))}><Spin on={action.busy === 'apps'}><Stethoscope size={14} /></Spin>Проверить приложения</button></header>
      <div className="panel-body"><small className="muted">Проверяет ключи приложений, адрес возврата и доступность картинок по публичному адресу. Ничего не публикует.</small></div>
      {checks?.media && <CheckList checks={[checks.media]} />}
    </section>
    <section className="panel">
      <header className="panel-head"><h2>Аккаунты профилей</h2><button className="ghost small" disabled={Boolean(action.busy)} onClick={() => void action.run('all', async () => { const result = await send<{ checked: number }>('/api/accounts', { action: 'diagnoseAll' }); await view.reload(); ctx.notify(`Проверено аккаунтов: ${result.checked}.`); })}><Spin on={action.busy === 'all'}><RefreshCw size={14} /></Spin>Проверить все</button></header>
      <div className="table-scroll"><table>
        <thead><tr><th>Профиль</th><th>Threads</th><th>Instagram</th></tr></thead>
        <tbody>{ctx.state.profiles.map(profile => <tr key={profile.id}>
          <td><span className="who"><Avatar profile={profile} /><strong>{profile.name}</strong></span></td>
          {['meta_threads', 'meta_instagram'].map(provider => {
            const account = accounts.find(row => row.profileId === profile.id && row.provider === provider && row.status !== 'disabled');
            const app = providers.find(row => row.provider === provider)?.app;
            if (!account) return <td key={provider}><button className="ghost small" disabled={!app || !base || Boolean(action.busy)} title={!app ? 'Сначала сохраните приложение Meta' : !base ? 'Сначала задайте публичный адрес' : ''} onClick={() => void connect(provider, profile.id)}><Plug size={14} />Подключить</button></td>;
            const problems = account.diagnostics?.checks.filter(check => check.state === 'fail' || check.state === 'warn').length || 0;
            return <td key={provider}><div className="post-text">
              <span className="field-row"><Network platform={account.platform} username={account.username} /><StatusPill status={account.status} /></span>
              <small className="muted">{[account.followers !== null ? `подписчиков: ${account.followers.toLocaleString('ru-RU')}` : '', account.quotaTotal ? `публикаций за сутки: ${account.quotaUsed ?? 0} из ${account.quotaTotal}` : '', account.tokenExpiresAt ? `доступ до ${formatDate(account.tokenExpiresAt)}` : ''].filter(Boolean).join(' · ')}</small>
              {account.paused && account.pausedUntil && <small className="error-text">Соцсеть попросила подождать: публикации ждут до {formatDate(account.pausedUntil!)}.</small>}
              {account.error && <small className="error-text">{account.error}</small>}
              {account.diagnostics && <small className={problems ? 'error-text' : 'muted'}>{problems ? `Проверка: замечаний ${problems}` : 'Проверка: всё в порядке'} ({formatDate(account.diagnostics.at)})</small>}
              <span className="row-actions">
                <button className="ghost small" onClick={() => setOpen(account)}><Stethoscope size={14} />Проверка</button>
                {account.status === 'expired' && <button className="ghost small" disabled={Boolean(action.busy)} onClick={() => void connect(provider, profile.id)}><Plug size={14} />Войти заново</button>}
                <button className="link" onClick={() => { if (confirm(`Отключить @${account.username} от FERMA? Опубликованное останется в соцсети, ожидающие публикации отменятся.`)) void action.run(account.id, async () => { await send('/api/accounts', { action: 'remove', accountId: account.id }); await view.reload(); }, 'Аккаунт отключён.'); }}><Trash2 size={13} />Отключить</button>
              </span>
            </div></td>;
          })}
        </tr>)}</tbody>
      </table></div>
      <div className="panel-note"><small className="muted">У каждого аккаунта свой токен: он хранится зашифрованным и продлевается сам за 15 дней до конца. Instagram публикует через API только профессиональные аккаунты (автор или бизнес). Прокси не используются.</small></div>
    </section>
    {open && <AccountModal ctx={ctx} account={open} profile={ctx.state.profiles.find(profile => profile.id === open.profileId)} close={() => setOpen(null)} onChanged={() => void view.reload()} />}
  </div>;
}
