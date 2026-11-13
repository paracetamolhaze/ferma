"use client";
import { useRef, useState } from 'react';
import { Download, Loader2, Trash2, Upload } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import { Avatar, type Ctx, type Profile } from './shared';

export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export async function uploadAvatar(profileId: string, file: File) {
  if (!AVATAR_TYPES.includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error('Нужна картинка JPG, PNG или WebP до 5 МБ.');
  return requestJson<{ avatar: string }>(`/api/avatar?profileId=${profileId}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
}

export function AvatarPanel({ profile, ctx }: { profile: Profile; ctx: Ctx }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(work: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await work(); await ctx.reload(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка.'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  return <section className="panel">
    <header className="panel-head"><h2>Аватарка</h2></header>
    <div className="panel-body">
      <div className="avatar-row">
        <Avatar profile={profile} size="large" />
        <div className="avatar-actions">
          <input ref={input} hidden type="file" accept={AVATAR_TYPES.join(',')} onChange={event => { const file = event.target.files?.[0]; if (file) void run(() => uploadAvatar(profile.id, file)); }} />
          <button className="primary small" disabled={busy} onClick={() => input.current?.click()}>{busy ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}{profile.avatar ? 'Заменить' : 'Загрузить'}</button>
          {profile.avatar && <>
            <a className="ghost small" href={`/api/avatar?profileId=${profile.id}&v=${profile.avatar}&download=1`} download><Download size={14} />Скачать для соцсетей</a>
            <button className="ghost small" disabled={busy} onClick={() => { if (window.confirm('Убрать аватарку из FERMA?')) void run(() => requestJson(`/api/avatar?profileId=${profile.id}`, { method: 'DELETE' })); }}><Trash2 size={14} />Убрать</button>
          </>}
        </div>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <p className="muted small-note">Zernio не умеет менять аватарку в соцсетях. Скачайте её и поставьте в Instagram и Threads вручную: в Threads она берётся из Instagram.</p>
    </div>
  </section>;
}
