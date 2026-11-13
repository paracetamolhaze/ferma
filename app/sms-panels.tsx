"use client";
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff, Loader2, Pencil, Smartphone } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import type { SmsMessage } from '@/lib/sms';
import { CopyButton, formatTime, type Ctx, type Profile } from './shared';

const post = <T,>(body: unknown) => requestJson<T>('/api/sms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function useRecentSms(enabled: boolean) {
  const [messages, setMessages] = useState<SmsMessage[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    try {
      const data = await requestJson<{ messages: SmsMessage[] }>('/api/sms', { signal });
      if (signal?.aborted) return;
      setMessages(data.messages); setError('');
    } catch (failure) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : 'Не удалось загрузить СМС.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    // Codes must appear on their own while a screen with them is open.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(controller.signal);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(controller.signal); }, 15000);
    return () => { clearInterval(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return { messages, error, loading, refresh };
}

export function ProfileSms({ profile, ctx }: { profile: Profile; ctx: Ctx }) {
  const id = useId();
  const connected = Boolean(ctx.state.sms);
  const { messages, error } = useRecentSms(connected);
  const [phone, setPhone] = useState(profile.phone || '');
  const [editing, setEditing] = useState(!profile.phone);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const own = (messages || []).filter(sms => sms.profileId === profile.id);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setSaveError('');
    try {
      const data = await post<{ phone: string | null }>({ action: 'phone', profileId: profile.id, phone });
      setPhone(data.phone || ''); setEditing(!data.phone);
      await ctx.reload();
    } catch (failure) { setSaveError(failure instanceof Error ? failure.message : 'Не удалось сохранить номер.'); }
    finally { setSaving(false); }
  }
  return <section className="panel">
    <header className="panel-head"><h2>СМС и коды</h2></header>
    <div className="panel-body">
      {!connected && <p className="muted">Приём СМС не подключён. <button className="link" onClick={() => ctx.go('settings')}>Открыть настройки</button></p>}
      {editing || !profile.phone
        ? <form onSubmit={save}>
            <label htmlFor={id}>Номер профиля</label>
            <div className="field-row">
              <input id={id} className="grow" inputMode="tel" autoComplete="off" maxLength={40} placeholder="+77001234567" value={phone} disabled={saving} onChange={event => { setPhone(event.target.value); setSaveError(''); }} />
              <button className="primary" disabled={saving || phone.trim() === (profile.phone || '')}>{saving && <Loader2 size={15} className="spin" />}Сохранить</button>
              {profile.phone && <button type="button" className="ghost" onClick={() => { setPhone(profile.phone!); setEditing(false); setSaveError(''); }}>Отмена</button>}
            </div>
            {saveError && <p className="error-text" role="alert">{saveError}</p>}
          </form>
        : <div className="address-line"><strong>{profile.phone}</strong><CopyButton value={profile.phone} label="Копировать" /><button type="button" className="ghost small" onClick={() => setEditing(true)}><Pencil size={14} />Изменить</button></div>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {connected && messages && (own.length
        ? <ul className="sms-list">{own.slice(0, 20).map(sms => <li key={sms.id}>
            <div className="sms-head"><strong>{sms.sender || 'Неизвестный отправитель'}</strong><time>{formatTime(sms.receivedAt)}</time></div>
            <p>{sms.text}</p>
            {sms.code && <span className="code-chip"><code>{sms.code}</code><CopyButton value={sms.code} /></span>}
          </li>)}</ul>
        : <p className="muted">СМС на этот номер пока нет. Список обновляется сам.</p>)}
    </div>
  </section>;
}

/** Android does not always know its own number: such a SIM is matched to a profile by hand, once. */
export function UnmatchedSms({ ctx, messages, onBound }: { ctx: Ctx; messages: SmsMessage[]; onBound: () => void }) {
  const [error, setError] = useState('');
  const lines = [...new Map(messages.filter(sms => !sms.profileId).map(sms => [sms.line, sms])).values()];
  if (!lines.length) return null;
  async function bind(line: string, profileId: string) {
    setError('');
    try { await post({ action: 'bind', profileId, line }); await ctx.reload(); onBound(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось привязать SIM.'); }
  }
  return <section className="panel">
    <header className="panel-head"><h2>СМС без профиля</h2></header>
    <ul className="plain-list">{lines.map(sms => <li key={sms.line}>
      <span className="post-text"><strong><Smartphone size={14} /> {sms.recipient || `SIM ${sms.sim ?? '?'}`}</strong><small>{sms.sender || 'Неизвестный отправитель'}: {sms.text}</small></span>
      <select className="compact-select" aria-label="Привязать к профилю" defaultValue="" onChange={event => { if (event.target.value) void bind(sms.line, event.target.value); }}>
        <option value="">Привязать к профилю…</option>
        {ctx.state.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
    </li>)}</ul>
    {error && <p className="error-text form-error" role="alert">{error}</p>}
  </section>;
}

export function SmsSettings({ ctx }: { ctx: Ctx }) {
  const sms = ctx.state.sms;
  const [signingKey, setSigningKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  async function toggleKey() {
    setError('');
    if (signingKey) { setSigningKey(''); return; }
    try { setSigningKey((await post<{ signingKey: string }>({ action: 'reveal' })).signingKey); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось показать ключ.'); }
  }
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(''); setDone(false);
    try { await post({ action: 'register', username, password }); setPassword(''); setUsername(''); setDone(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось подключить телефон.'); }
    finally { setSaving(false); }
  }
  return <section className="panel">
    <header className="panel-head"><h2>СМС (телефон с eSIM)</h2><span className={`pill ${sms ? 'good' : 'plain'}`}>{sms ? 'Приёмник работает' : 'Не подключён'}</span></header>
    <div className="panel-body">
      {!sms ? <p className="muted">Приёмник СМС ещё не развёрнут.</p> : <>
        <ol className="steps">
          <li>Установите на Android-телефон приложение <a className="link" href="https://sms-gate.app" target="_blank" rel="noreferrer">SMS Gateway for Android</a> и включите на главном экране облачный режим.</li>
          <li>В приложении откройте Settings → Webhooks → Signing Key и вставьте ключ:
            <span className="key-line">
              <code>{signingKey || '••••••••••••••••'}</code>
              {signingKey && <CopyButton value={signingKey} />}
              <button type="button" className="ghost small" onClick={() => void toggleKey()}>{signingKey ? <EyeOff size={14} /> : <Eye size={14} />}{signingKey ? 'Скрыть' : 'Показать'}</button>
            </span>
          </li>
          <li>Введите логин и пароль с главного экрана приложения. Они нужны один раз и не сохраняются.
            <form className="field-row" onSubmit={register}>
              <input className="grow" autoComplete="off" spellCheck={false} placeholder="Логин" aria-label="Логин из приложения" value={username} disabled={saving} onChange={event => setUsername(event.target.value)} />
              <input className="grow" type="password" autoComplete="off" placeholder="Пароль" aria-label="Пароль из приложения" value={password} disabled={saving} onChange={event => setPassword(event.target.value)} />
              <button className="primary" disabled={saving || !username.trim() || !password}>{saving && <Loader2 size={15} className="spin" />}Подключить телефон</button>
            </form>
          </li>
          <li>Укажите номер в профиле и отправьте на него тестовую СМС.</li>
        </ol>
        {done && <p className="key-saved" role="status"><Check size={16} />Телефон подключён. Отправьте тестовую СМС.</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
        <p className="muted small-note">Не давайте телефону засыпать: разрешите приложению работать в фоне и отключите для него экономию заряда.</p>
      </>}
    </div>
  </section>;
}
