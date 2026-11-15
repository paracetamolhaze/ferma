"use client";
/**
 * «Подключения» of one profile: Instagram and Threads through the owner's Meta apps and YouTube through the Google
 * app (FERMA connects them itself), and what is connected in Zernio (TikTok and the autopilot's channels). Shows
 * what is connected and connects what is not.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, Plug, RefreshCw } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import { ErrorLine, Spin, useAction, useApi } from './content-ui';
import { formatDate, networkName, StatusPill, type Ctx, type Profile } from './shared';
import { connectUrl, OWN_PROVIDERS } from './view-accounts';

export type OwnAccounts = {
  providers: { provider: string; app: { appId: string } | null; capabilities: { inactive?: string } }[];
  accounts: { id: string; profileId: string; provider: string; platform: string; username: string | null; followers: number | null; status: string; tokenExpiresAt: string | null; error: string | null }[];
};
type ZernioAccount = { id: string; platform: string; username: string | null; active: boolean };
const VIA: Record<string, string> = { meta_instagram: 'приложение Meta', meta_threads: 'приложение Meta', youtube: 'приложение Google' };
const Icon = ({ platform }: { platform: string }) => <img src={`/icons/${platform}.svg`} width={22} height={22} alt="" />;

/** Zernio's own login page for a network, opened in a new window; the list is read again on coming back. */
function useZernioConnect(profileId: string, reload: () => void) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!waiting) return;
    const onFocus = () => { setWaiting(false); reload(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [waiting, reload]);
  async function connect(platform: string) {
    setError('');
    // Opened before the request, so the browser treats it as the click's own window.
    const tab = window.open('', '_blank');
    try {
      const { authUrl } = await requestJson<{ authUrl: string }>('/api/zernio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId, connect: platform }) });
      if (tab) { tab.opener = null; tab.location.assign(authUrl); } else window.location.assign(authUrl);
      setWaiting(true);
    } catch (failure) { tab?.close(); setError(failure instanceof Error ? failure.message : 'Не удалось начать подключение.'); }
  }
  return { connect, error };
}

export function ProfileConnections({ ctx, profile, own, onOpenSettings }: { ctx: Ctx; profile: Profile; own: OwnAccounts | null; onOpenSettings: () => void }) {
  const action = useAction(ctx);
  const zernio = useApi<{ accounts: ZernioAccount[] }>(profile.configured ? `/api/zernio?view=accounts&profileId=${profile.id}` : null);
  const zernioConnect = useZernioConnect(profile.id, zernio.reload);
  const zernioAccounts = zernio.data?.accounts || [];
  return <section className="panel">
    <header className="panel-head"><h2>Подключения</h2></header>
    <ErrorLine text={action.error || zernioConnect.error} />
    <ul className="plain-list">
      {OWN_PROVIDERS.map(({ provider, platform, name }) => {
        const account = own?.accounts.find(row => row.profileId === profile.id && row.provider === provider && row.status !== 'disabled');
        const entry = own?.providers.find(row => row.provider === provider);
        const connect = () => void action.run(provider, async () => { location.href = await connectUrl(provider, profile.id); });
        return <li key={provider}>
          <Icon platform={platform} />
          <span className="post-text">
            <strong>{name}{account ? `: ${provider === 'youtube' ? `«${account.username}»` : `@${account.username}`}` : ''}</strong>
            <small>{account
              ? [`через ${VIA[provider]}`, account.followers !== null ? `подписчиков: ${account.followers.toLocaleString('ru-RU')}` : '', account.tokenExpiresAt ? `доступ до ${formatDate(account.tokenExpiresAt)}` : '', provider === 'youtube' ? 'публикация видео — следующий этап' : ''].filter(Boolean).join(' · ')
              : !entry?.app ? `Сначала добавьте ${provider === 'youtube' ? 'приложение Google' : 'приложение Meta'} в «Аккаунтах».` : `Не подключён. Вход через ${VIA[provider]}.`}</small>
            {account?.error && account.status !== 'connected' && <small className="error-text">{account.error}</small>}
          </span>
          <span className="row-actions">
            {account && <StatusPill status={account.status} />}
            {(!account || account.status === 'expired') && <button className="ghost small" disabled={!entry?.app || Boolean(action.busy)} onClick={connect}><Spin on={action.busy === provider}><Plug size={14} /></Spin>{account ? 'Войти заново' : 'Подключить'}</button>}
          </span>
        </li>;
      })}
      <li>
        <Icon platform="tiktok" />
        <span className="post-text">
          <strong>Zernio</strong>
          {!profile.configured ? <small>Нет ключа Zernio. Его добавляют в «Настройках» профиля.</small>
            : zernio.error ? <small className="error-text">{zernio.error}</small>
            : zernio.loading && !zernio.data ? <small>Спрашиваем Zernio…</small>
            : zernioAccounts.length ? <small className="wrap">{zernioAccounts.map(item => `${networkName(item.platform)} @${(item.username || '').replace(/^@/, '')}${item.active ? '' : ' (переподключить)'}`).join(' · ')}</small>
            : <small>В Zernio у профиля пока ничего не подключено.</small>}
        </span>
        <span className="row-actions">
          {profile.configured && !zernioAccounts.some(item => item.platform === 'tiktok' && item.active) && <button className="ghost small" onClick={() => void zernioConnect.connect('tiktok')}><Plug size={14} />Подключить TikTok</button>}
          {profile.configured && <button className="icon-button" title="Обновить" aria-label="Обновить подключения Zernio" onClick={() => void zernio.reload()}><RefreshCw size={15} /></button>}
          {!profile.configured ? <button className="link" onClick={onOpenSettings}>Настройки</button> : <a className="icon-button" href="https://zernio.com" target="_blank" rel="noreferrer" title="Открыть Zernio" aria-label="Открыть Zernio"><ExternalLink size={15} /></a>}
        </span>
      </li>
    </ul>
    <div className="panel-note"><small className="muted">Instagram, Threads и YouTube FERMA подключает сама, через ваши приложения. Через Zernio идут TikTok и автопилот; какие из этих соцсетей пишет автопилот, выбирается в «Настройках».</small></div>
  </section>;
}
