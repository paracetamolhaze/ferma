"use client";
import { useEffect, useState, type FormEvent } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import type { Profile } from './shared';

type Source = { tgChannel: string | null; tgLastId: number | null; replies: boolean; repliesSent: number };

export function SocialPanel({ profile }: { profile: Profile }) {
  const [source, setSource] = useState<Source | null>(null);
  const [channel, setChannel] = useState('');
  const [replies, setReplies] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    requestJson<Source>(`/api/social?profileId=${profile.id}`).then(data => { setSource(data); setChannel(data.tgChannel ? `@${data.tgChannel}` : ''); setReplies(data.replies); }).catch(failure => setError(failure.message));
  }, [profile.id]);
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setSaved(false);
    try {
      const data = await requestJson<Source>('/api/social', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', profileId: profile.id, tgChannel: channel, replies }) });
      setSource(data); setChannel(data.tgChannel ? `@${data.tgChannel}` : ''); setSaved(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить.'); }
    finally { setSaving(false); }
  }
  return <section className="panel">
    <header className="panel-head"><h2>Threads: канал и ответы</h2></header>
    <div className="panel-body">
      <form className="form-stack" onSubmit={save}>
        <label>Telegram-канал <span className="hint">публичный, необязательно</span>
          <input value={channel} maxLength={200} spellCheck={false} autoComplete="off" placeholder="@mychannel или https://t.me/mychannel" disabled={saving || !source} onChange={event => { setChannel(event.target.value); setSaved(false); setError(''); }} />
        </label>
        <p className="muted small-note">Новые посты канала уходят в Threads этого профиля в течение двух минут, с текстом и фото как есть. Если компьютер был выключен, пропущенные посты выйдут после включения. Видео, опросы и пересланные посты пропускаются. Старые посты канала не публикуются.</p>
        {source?.tgChannel && <p className="muted small-note">{source.tgLastId === null ? 'Канал подключается, первая проверка в течение двух минут.' : `Последний учтённый пост канала: №${source.tgLastId}.`}</p>}
        <label className="switch"><input type="checkbox" checked={replies} disabled={saving || !source} onChange={event => { setReplies(event.target.checked); setSaved(false); }} />Отвечать на комментарии в Threads</label>
        <p className="muted small-note">Ответы пишет GPT-мост в голосе профиля: не больше 6 в час и 30 в сутки, с паузой от 5 минут. На спам, грубость и ссылки не отвечает.{source ? ` Отправлено ответов: ${source.repliesSent}.` : ''}</p>
        {error && <p className="error-text" role="alert">{error}</p>}
        {saved && <p className="key-saved" role="status"><Check size={16} />Сохранено.</p>}
        <button className="primary small" style={{ justifySelf: 'start' }} disabled={saving || !source}>{saving && <Loader2 size={14} className="spin" />}Сохранить</button>
      </form>
    </div>
  </section>;
}
