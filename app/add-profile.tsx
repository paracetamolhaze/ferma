"use client";
import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import { profileColors } from '@/lib/profile-colors';
import { Modal, type Ctx } from './shared';

const LETTERS: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
export const emailFromName = (name: string) => [...name.trim().toLowerCase()].map(char => LETTERS[char] ?? char).join('').replace(/[^a-z0-9]+/g, '').slice(0, 40);
const post = (url: string, body: unknown) => requestJson<Record<string, string>>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default function AddProfile({ ctx, close }: { ctx: Ctx; close: () => void }) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [local, setLocal] = useState('');
  const [localEdited, setLocalEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const domain = ctx.state.mail?.domain;
  const address = localEdited ? local : emailFromName(name);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError('');
    let id = '';
    try {
      const color = profileColors[ctx.state.profiles.length % profileColors.length][0];
      id = (await post('/api/workspace', { action: 'profile', name: name.trim(), description: '', color })).id;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось создать профиль.');
      setSaving(false);
      return;
    }
    // The profile exists from here on; a rejected key or address must not lose it.
    const problems: string[] = [];
    if (apiKey.trim()) {
      try { await post('/api/settings', { profileId: id, apiKey: apiKey.trim() }); }
      catch (failure) { problems.push(`Ключ не сохранён: ${failure instanceof Error ? failure.message : 'ошибка'}`); }
    }
    if (domain && address) {
      try { await post('/api/mail', { action: 'address', profileId: id, local: address }); }
      catch (failure) { problems.push(`Адрес не сохранён: ${failure instanceof Error ? failure.message : 'ошибка'}`); }
    }
    await ctx.reload();
    ctx.notify(problems.length ? `Профиль создан. ${problems.join(' ')}` : 'Профиль создан.');
    close();
    ctx.go(`profile/${id}/${problems.length || !apiKey.trim() ? 'settings' : 'overview'}`);
  }
  return <Modal title="Новый профиль" close={() => !saving && close()}>
    <form onSubmit={submit}>
      <div className="form-body">
        <label>Название<input autoFocus required maxLength={80} value={name} disabled={saving} onChange={event => setName(event.target.value)} placeholder="Например, Хозяин квартиры" /></label>
        <label>Ключ Zernio <span className="hint">можно добавить позже</span>
          <span className="input-with-button">
            <input type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={4096} value={apiKey} disabled={saving} onChange={event => setApiKey(event.target.value)} placeholder="Вставьте API-ключ" />
            <button type="button" className="icon-button" aria-label={showKey ? 'Скрыть ключ' : 'Показать ключ'} onClick={() => setShowKey(value => !value)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button>
          </span>
        </label>
        {domain
          ? <label>Адрес почты
              <span className="input-with-suffix">
                <input maxLength={64} spellCheck={false} autoComplete="off" value={address} disabled={saving} onChange={event => { setLocal(event.target.value); setLocalEdited(true); }} placeholder="имя латиницей" />
                <span>@{domain}</span>
              </span>
            </label>
          : <p className="muted">Почта не подключена. Её можно подключить в настройках.</p>}
        {error && <p className="error-text" role="alert">{error}</p>}
      </div>
      <div className="modal-footer">
        <button type="button" className="ghost" disabled={saving} onClick={close}>Отмена</button>
        <button className="primary" disabled={saving || !name.trim()}>{saving && <Loader2 size={16} className="spin" />}{saving ? 'Создаём…' : 'Создать профиль'}</button>
      </div>
    </form>
  </Modal>;
}
