"use client";
import { useId, useState, type FormEvent } from 'react';
import { Check, Loader2, ShieldCheck } from 'lucide-react';
import { requestJson } from '@/lib/client-api';

export default function MailSettingsForm({ mail, canSave, onSaved }: { mail: { baseUrl: string; domain: string } | null; canSave: boolean; onSaved: () => Promise<unknown> }) {
  const id = useId();
  const [baseUrl, setBaseUrl] = useState(mail?.baseUrl || '');
  const [domain, setDomain] = useState(mail?.domain || '');
  const [apiToken, setApiToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(''); setSaved(false);
    try {
      const data = await requestJson<{ baseUrl: string; domain: string }>('/api/mail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settings', baseUrl, domain, ...(apiToken.trim() ? { apiToken: apiToken.trim() } : {}) }) });
      setBaseUrl(data.baseUrl); setDomain(data.domain); setApiToken('');
      await onSaved();
      setSaved(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось подключить почту.'); }
    finally { setSaving(false); }
  }
  const clear = () => { setError(''); setSaved(false); };
  return <form className="api-key-form" onSubmit={submit}>
    <label htmlFor={`${id}-url`}>Адрес сервиса MailClaw</label>
    <input id={`${id}-url`} type="url" required maxLength={500} spellCheck={false} autoComplete="off" placeholder="https://mailclaw.example.workers.dev" value={baseUrl} disabled={saving} onChange={event => { setBaseUrl(event.target.value); clear(); }} />
    <label htmlFor={`${id}-domain`}>Домен почты</label>
    <input id={`${id}-domain`} required maxLength={253} spellCheck={false} autoComplete="off" placeholder="mail.example.com" value={domain} disabled={saving} onChange={event => { setDomain(event.target.value); clear(); }} />
    <label htmlFor={`${id}-token`}>{mail ? 'Новый API-токен' : 'API-токен'}</label>
    <input id={`${id}-token`} type="password" required={!mail} maxLength={4096} spellCheck={false} autoComplete="off" placeholder={mail ? 'Оставьте пустым, чтобы не менять' : 'Вставьте API_TOKEN из MailClaw'} value={apiToken} disabled={saving} onChange={event => { setApiToken(event.target.value); clear(); }} />
    {mail && <p className="muted">При смене домена адреса всех профилей перейдут на новый домен.</p>}
    {error && <div className="error-text" role="alert">{error}</div>}
    {saved && <div className="key-saved" role="status"><Check size={16} />Почта проверена и подключена.</div>}
    <button type="submit" className="primary" disabled={saving || !canSave}>{saving ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}{saving ? 'Проверяем…' : mail ? 'Проверить и сохранить' : 'Проверить и подключить'}</button>
  </form>;
}
