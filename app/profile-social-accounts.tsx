"use client";
import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { NETWORKS } from '@/lib/domain';
import type { ImportResult } from '@/lib/social-import';
import { requestJson } from '@/lib/client-api';

type Channel = { id: string; platform: string; username: string | null; state: string };
export default function ProfileSocialAccounts({ profileId, configured, revision, channels, onUpdated }: { profileId: string; configured: boolean; revision: number; channels: Channel[]; onUpdated: () => Promise<unknown> }) {
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remoteProfileId, setRemoteProfileId] = useState('');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  async function sync(selection: { remoteProfileId?: string; accountIds?: string[] } = {}, signal?: AbortSignal) {
    setBusy(true); setError('');
    try {
      const data = await requestJson<ImportResult>('/api/workspace', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'importAccounts', profileId, ...selection }) });
      if (signal?.aborted) return;
      setResult(data); setAccountIds([]);
      setRemoteProfileId(data.status === 'chooseAccounts' ? data.profiles?.[0]?.id || '' : '');
      await onUpdated();
    } catch (error) { if (!signal?.aborted) setError(error instanceof Error ? error.message : 'Не удалось загрузить соцсети.'); }
    finally { if (!signal?.aborted) setBusy(false); }
  }
  useEffect(() => {
    if (!configured) return;
    const controller = new AbortController();
    // Start the import and its loading indicator when the selected profile changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void sync({}, controller.signal);
    return () => controller.abort();
    // Only profile/key changes trigger automatic import, not the following workspace reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, configured, revision]);
  return <section className="profile-social-section">
    <div className="section-title"><h3>Социальные сети</h3><span>{channels.length} / 2</span></div>
    <p className="muted">Подключайте соцсети в Zernio — здесь они появятся автоматически.</p>
    <div className="social-import-actions"><a href="https://zernio.com" target="_blank" rel="noreferrer" className="secondary"><ExternalLink size={15} />Открыть Zernio</a><button className="secondary" disabled={busy || !configured} onClick={() => void sync()}>{busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}{busy ? 'Загружаем соцсети…' : 'Обновить соцсети'}</button></div>
    {error && <p className="error-text" role="alert">{error}</p>}
    {result?.status === 'chooseProfile' && <form className="import-choice" onSubmit={event => { event.preventDefault(); void sync({ remoteProfileId }); }}>
      <label>Профиль в Zernio<select value={remoteProfileId} required disabled={busy} onChange={event => setRemoteProfileId(event.target.value)}><option value="">Выберите профиль</option>{result.profiles?.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      <button className="primary" disabled={busy || !remoteProfileId}>Подтянуть соцсети</button>
    </form>}
    {result?.status === 'chooseAccounts' && <form className="import-choice" onSubmit={event => { event.preventDefault(); void sync({ remoteProfileId, accountIds }); }}>
      <p>Выберите до двух соцсетей для этого профиля — по одному аккаунту каждой сети.</p>
      {result.accounts?.map(account => {
        const selected = accountIds.includes(account.id);
        const duplicatePlatform = result.accounts?.some(other => accountIds.includes(other.id) && other.platform === account.platform);
        return <label className="import-account-option" key={account.id}><input type="checkbox" checked={selected} disabled={busy || (!selected && (accountIds.length >= 2 || duplicatePlatform))} onChange={event => setAccountIds(event.target.checked ? [...accountIds, account.id] : accountIds.filter(id => id !== account.id))} /><span>{NETWORKS.find(network => network.id === account.platform)?.name} · {account.username}{!account.active && ' · требуется переподключение в Zernio'}</span></label>;
      })}
      <button className="primary" disabled={busy || !accountIds.length}>Сохранить выбор</button>
    </form>}
    <div className="connect-list">{channels.map(channel => <div className="connect-row" key={channel.id}>
      <img src={`/icons/${channel.platform === 'twitter' ? 'x' : channel.platform}.svg`} width={23} height={23} alt="" />
      <div><strong>{NETWORKS.find(network => network.id === channel.platform)?.name}</strong><small>{channel.username ? `@${channel.username.replace(/^@/, '')}` : 'Без имени'}</small></div>
      <span className={`pill ${channel.state === 'connected' ? 'success' : 'neutral'}`}>{channel.state === 'connected' ? 'Подключено' : 'Проверьте в Zernio'}</span>
    </div>)}</div>
    {!channels.length && !busy && result?.status !== 'chooseProfile' && result?.status !== 'chooseAccounts' && <p className="form-note">{!configured ? 'Добавьте API-ключ этого профиля, чтобы загрузить его соцсети.' : result?.message || 'Соцсети ещё не загружены. Нажмите «Обновить соцсети».'}</p>}
  </section>;
}
