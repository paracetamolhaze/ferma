"use client";
import { useId, useState, type FormEvent } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { requestJson } from '@/lib/client-api';

export default function ProfileNameForm({ profileId, name, onSaved }: { profileId: string; name: string; onSaved: () => Promise<unknown> }) {
  const id = useId();
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(''); setSaved(false);
    try {
      await requestJson('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'renameProfile', profileId, name: value.trim() }) });
      setValue(value.trim()); await onSaved(); setSaved(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось изменить имя.'); }
    finally { setSaving(false); }
  }
  return <form className="profile-name-form" onSubmit={submit}>
    <label htmlFor={id}>Название профиля</label>
    <div className="profile-name-row"><input className="form-control" id={id} value={value} required maxLength={80} disabled={saving} onChange={event => { setValue(event.target.value); setSaved(false); setError(''); }} /><button className="secondary" disabled={saving || !value.trim() || value.trim() === name}>{saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Сохранить имя</button></div>
    {error && <p className="error-text" role="alert">{error}</p>}
    {saved && <p className="key-saved" role="status">Имя сохранено.</p>}
  </form>;
}
