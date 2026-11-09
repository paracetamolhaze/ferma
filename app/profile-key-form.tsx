"use client";

import { useId, useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { requestJson } from '@/lib/client-api';

export default function ProfileKeyForm({ profileId, name, configured, canSave, onSaved }: {
  profileId: string; name: string; configured: boolean; canSave: boolean; onSaved: () => Promise<unknown>;
}) {
  const id = useId();
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [visibleKey, setVisibleKey] = useState('');
  const [revealing, setRevealing] = useState(false);
  const [showNewKey, setShowNewKey] = useState(false);
  async function toggleSavedKey() {
    if (visibleKey) { setVisibleKey(''); return; }
    setRevealing(true); setError('');
    try {
      const data = await requestJson<{ apiKey: string }>('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reveal', profileId }) });
      setVisibleKey(data.apiKey);
    } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось показать ключ.'); }
    finally { setRevealing(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVisibleKey('');
    setSaving(true); setError(''); setSaved(false);
    try {
      const data = await requestJson<{ warning?: string }>('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId, apiKey: apiKey.trim() }) });
      setApiKey('');
      setShowNewKey(false);
      await onSaved();
      setSaved(true);
      if (data.warning) setError(data.warning);
    } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось сохранить ключ.'); }
    finally { setSaving(false); }
  }
  return <form className="api-key-form profile-key-form" onSubmit={submit}>
    <div className="profile-key-heading"><strong>API-ключ Zernio</strong><span className={`pill ${configured ? 'success' : 'neutral'}`}>{configured ? 'Ключ добавлен' : 'Нет ключа'}</span></div>
    {configured && <div className="saved-key-block">
      <label htmlFor={`${id}-saved`}>Сохранённый ключ</label>
      <div className="key-input-row"><input id={`${id}-saved`} readOnly type={visibleKey ? 'text' : 'password'} value={visibleKey || '••••••••••••••••••••••••'} autoComplete="off" spellCheck={false} /><button type="button" className="secondary" disabled={revealing || saving} onClick={() => void toggleSavedKey()} aria-pressed={Boolean(visibleKey)}>{revealing ? <Loader2 size={16} className="spin" /> : visibleKey ? <EyeOff size={16} /> : <Eye size={16} />}{visibleKey ? 'Скрыть' : 'Показать'}</button></div>
    </div>}
    <label htmlFor={id}>{configured ? 'Новый ключ' : `Ключ профиля «${name}»`}</label>
    <div className="key-input-row"><input id={id} type={showNewKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder={configured ? 'Вставьте ключ для замены' : 'Вставьте API-ключ профиля'} value={apiKey} maxLength={4096} required disabled={saving || !canSave} onChange={event => { setApiKey(event.target.value); setError(''); setSaved(false); }} aria-describedby={`${id}-help`} /><button type="button" className="secondary key-visibility" aria-label={showNewKey ? 'Скрыть новый ключ' : 'Показать новый ключ'} aria-pressed={showNewKey} onClick={() => setShowNewKey(value => !value)}>{showNewKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
    {configured && <p className="muted">Можно использовать ключ другого кабинета. Соцсети загрузятся заново; отправленные публикации останутся в прежнем Zernio.</p>}
    <p id={`${id}-help`} className="muted">{canSave ? 'Ключ зашифрован и используется только этим профилем.' : 'Хранилище ключей не настроено на сервере.'}</p>
    {error && <div className="error-text" role="alert">{error}</div>}
    {saved && <div className="key-saved" role="status"><Check size={16} />Ключ этого профиля проверен и сохранён.</div>}
    <button type="submit" className="primary" disabled={saving || revealing || !canSave || !apiKey.trim()}>{saving ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}{saving ? 'Проверяем ключ…' : configured ? 'Проверить и заменить' : 'Проверить и сохранить'}</button>
  </form>;
}
