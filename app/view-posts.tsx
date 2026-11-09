"use client";
import { useState } from 'react';
import { ExternalLink, FileText, Image as ImageIcon, Loader2, Pencil, Plus, RefreshCw, Trash2, Video, X } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import type { ProfileQueue, RemotePost } from '@/lib/zernio-insights';
import { Empty, formatDate, Network, problemStatuses, Segmented, StatusPill, useZernio, type Ctx, type Post, type Profile } from './shared';

type Row = { key: string; profile: Profile | undefined; title: string; text: string; status: string; at: string | null; queued: boolean; media: string | null; platforms: string[]; links: { platform: string; url: string }[]; error: string | null; local: Post | null };
type Filter = 'all' | 'draft' | 'scheduled' | 'published' | 'problem';
const DAYS = [{ id: 1, text: 'Пн' }, { id: 2, text: 'Вт' }, { id: 3, text: 'Ср' }, { id: 4, text: 'Чт' }, { id: 5, text: 'Пт' }, { id: 6, text: 'Сб' }, { id: 0, text: 'Вс' }];
const matches = (row: Row, filter: Filter) => filter === 'all' ? true : filter === 'problem' ? problemStatuses.includes(row.status) : filter === 'scheduled' ? ['scheduled', 'sending', 'publishing', 'processing'].includes(row.status) : row.status === filter;

export function PostsPanel({ ctx, profiles, limit }: { ctx: Ctx; profiles: Profile[]; limit?: number }) {
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const results = useZernio<{ posts: RemotePost[]; total: number }>(profiles.filter(profile => profile.configured), 'view=posts', revision);
  const ids = new Set(profiles.map(profile => profile.id));
  const single = profiles.length === 1;
  const find = (id: string) => profiles.find(profile => profile.id === id);
  const known = new Set(Object.values(results).flatMap(item => item.data?.posts.map(post => post.id) || []));
  const local: Row[] = ctx.state.posts.filter(post => ids.has(post.profileId) && !(post.zernioId && known.has(post.zernioId))).map(post => {
    const media = ctx.state.media.find(item => item.id === post.mediaId);
    return { key: post.id, profile: find(post.profileId), title: post.title, text: post.content, status: post.status, at: post.scheduledFor, queued: false, media: media ? media.type.split('/')[0] : null, platforms: JSON.parse(post.platforms) as string[], links: [], error: post.error, local: post };
  });
  const remote: Row[] = Object.entries(results).flatMap(([id, item]) => (item.data?.posts || []).map(post => ({
    key: post.id, profile: find(id), title: post.title, text: post.content, status: post.status, at: post.at, queued: post.queued, media: post.media,
    platforms: post.platforms.map(entry => entry.platform), links: post.platforms.flatMap(entry => entry.url ? [{ platform: entry.platform, url: entry.url }] : []),
    error: post.platforms.map(entry => entry.error).filter(Boolean).join('; ') || null, local: null,
  })));
  const all = [...local, ...remote];
  const counts = (value: Filter) => all.filter(row => matches(row, value)).length;
  const search = query.trim().toLowerCase();
  const rows = all.filter(row => matches(row, filter) && (!search || `${row.title} ${row.text}`.toLowerCase().includes(search)))
    .sort((a, b) => (b.status === 'draft' ? 1 : 0) - (a.status === 'draft' ? 1 : 0) || (b.at || '').localeCompare(a.at || ''));
  const shown = limit ? rows.slice(0, limit) : rows;
  const loading = Object.values(results).some(item => item.loading);
  const errors = Object.entries(results).flatMap(([id, item]) => item.error ? [{ id, error: item.error }] : []);
  const hidden = Object.values(results).some(item => item.data && item.data.total > item.data.posts.length);
  return <div className="stack">
    <div className="toolbar">
      <Segmented label="Статус" value={filter} onChange={setFilter} options={[
        { id: 'all', text: 'Все', count: all.length }, { id: 'draft', text: 'Черновики', count: counts('draft') }, { id: 'scheduled', text: 'Запланированы', count: counts('scheduled') },
        { id: 'published', text: 'Опубликованы', count: counts('published') }, { id: 'problem', text: 'Ошибки', count: counts('problem') },
      ]} />
      <input className="search" type="search" placeholder="Поиск по тексту" aria-label="Поиск публикации" value={query} onChange={event => setQuery(event.target.value)} />
      <button className="ghost" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Обновить</button>
    </div>
    {errors.map(item => <p className="notice-bad" role="alert" key={item.id}>{single ? '' : `${find(item.id)?.name}: `}{item.error}</p>)}
    {shown.length ? <section className="panel"><div className="table-scroll"><table className="posts">
      <thead><tr><th>Публикация</th>{!single && <th>Профиль</th>}<th>Куда</th><th>Когда</th><th>Статус</th><th /></tr></thead>
      <tbody>{shown.map(row => <tr key={row.key}>
        <td><div className="post-cell">
          <span className="post-icon">{row.media === 'video' ? <Video size={15} /> : row.media === 'image' ? <ImageIcon size={15} /> : <FileText size={15} />}</span>
          <span className="post-text"><strong>{row.title || row.text || 'Без названия'}</strong>{row.title && row.text && <small>{row.text}</small>}{row.error && <small className="error-text">{row.error}</small>}</span>
        </div></td>
        {!single && <td>{row.profile ? <button className="link" onClick={() => ctx.go(`profile/${row.profile!.id}`)}>{row.profile.name}</button> : '—'}</td>}
        <td><span className="networks">{row.platforms.length ? row.platforms.map(platform => <Network key={platform} platform={platform} />) : '—'}</span></td>
        <td className="nowrap">{row.at ? formatDate(row.at) : '—'}{row.queued && <small className="block-note">из очереди</small>}</td>
        <td><StatusPill status={row.status} /></td>
        <td className="row-actions">
          {row.links.map(link => <a key={link.url} className="icon-button" href={link.url} target="_blank" rel="noreferrer" title="Открыть в соцсети" aria-label="Открыть в соцсети"><ExternalLink size={15} /></a>)}
          {row.local?.status === 'draft' && <>
            <button className="primary small" onClick={() => ctx.plan(row.local!)}>Запланировать</button>
            <button className="icon-button" title="Редактировать" aria-label={`Редактировать ${row.title}`} onClick={() => ctx.edit(row.local!)}><Pencil size={15} /></button>
            <button className="icon-button" title="Удалить" aria-label={`Удалить ${row.title}`} disabled={ctx.busy} onClick={() => ctx.remove(row.local!)}><Trash2 size={15} /></button>
          </>}
          {row.local?.status === 'uncertain' && <button className="ghost small" onClick={() => ctx.plan(row.local!)}>Проверить отправку</button>}
        </td>
      </tr>)}</tbody>
    </table></div></section>
    : !loading && <Empty title={all.length ? 'Ничего не найдено' : 'Публикаций пока нет'} text={all.length ? 'Измените статус или поиск.' : 'Создайте первую публикацию.'} action={!all.length && <button className="primary" onClick={() => ctx.compose(single ? profiles[0].id : undefined)}><Plus size={16} />Новая публикация</button>} />}
    {(hidden || (limit && rows.length > limit)) && <p className="muted small-note">Показаны последние публикации. Самые старые смотрите в кабинете Zernio.</p>}
  </div>;
}

const slotsText = (queue: ProfileQueue) => DAYS.flatMap(day => {
  const times = queue.slots.filter(slot => slot.dayOfWeek === day.id).map(slot => slot.time).sort();
  return times.length ? [`${day.text} ${times.join(', ')}`] : [];
}).join(' · ');

export function QueueOverview({ ctx, profiles }: { ctx: Ctx; profiles: Profile[] }) {
  const results = useZernio<ProfileQueue>(profiles, 'view=queue');
  if (!profiles.length) return null;
  return <section className="panel">
    <header className="panel-head"><h2>Автопубликация</h2></header>
    <div className="table-scroll"><table>
      <thead><tr><th>Профиль</th><th>Расписание</th><th>Следующий слот</th><th>Состояние</th></tr></thead>
      <tbody>{profiles.map(profile => {
        const entry = results[profile.id], queue = entry?.data;
        return <tr key={profile.id} className="clickable" onClick={() => ctx.go(`profile/${profile.id}/queue`)}>
          <td>{profile.name}</td>
          {queue ? <><td>{queue.slots.length ? slotsText(queue) : '—'}</td><td className="nowrap">{queue.active && queue.nextSlots[0] ? formatDate(queue.nextSlots[0]) : '—'}</td><td><span className={`pill ${queue.exists && queue.active ? 'good' : 'plain'}`}>{queue.exists ? queue.active ? 'Включена' : 'Выключена' : 'Не настроена'}</span></td></>
            : <td colSpan={3} className="muted">{entry?.loading ? 'Загружаем…' : entry?.error || 'Нет данных'}</td>}
        </tr>;
      })}</tbody>
    </table></div>
  </section>;
}

export function QueueEditor({ profile, ctx }: { profile: Profile; ctx: Ctx }) {
  const [revision, setRevision] = useState(0);
  const result = useZernio<ProfileQueue>([profile], 'view=queue', revision)[profile.id];
  const [draft, setDraft] = useState<{ slots: ProfileQueue['slots']; active: boolean } | null>(null);
  const [time, setTime] = useState('12:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5, 6, 0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const queue = result?.data;
  const current = draft || (queue ? { slots: queue.slots, active: queue.exists ? queue.active : true } : null);
  if (!current) return <section className="panel"><div className="panel-body">{result?.error ? <p className="notice-bad" role="alert">{result.error}</p> : <p className="muted"><Loader2 size={14} className="spin" /> Загружаем расписание…</p>}</div></section>;
  const change = (next: Partial<typeof current>) => { setDraft({ ...current, ...next }); setError(''); };
  const add = () => change({ slots: [...current.slots, ...days.filter(day => !current.slots.some(slot => slot.dayOfWeek === day && slot.time === time)).map(day => ({ dayOfWeek: day, time }))] });
  async function save() {
    setSaving(true); setError('');
    try {
      await requestJson('/api/zernio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileId: profile.id, slots: current!.slots, active: current!.active }) });
      setDraft(null); setRevision(value => value + 1); ctx.notify('Расписание сохранено в Zernio.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить расписание.'); }
    finally { setSaving(false); }
  }
  return <section className="panel">
    <header className="panel-head"><h2>Расписание автопубликации</h2>
      <label className="switch"><input type="checkbox" checked={current.active} onChange={event => change({ active: event.target.checked })} />Включена</label>
    </header>
    <div className="panel-body stack">
      <p className="muted">Планируя публикацию, выберите «В очередь»: она выйдет в ближайший свободный слот. Время по Кызылорде.</p>
      <div className="week">{DAYS.map(day => {
        const slots = current.slots.filter(slot => slot.dayOfWeek === day.id).sort((a, b) => a.time.localeCompare(b.time));
        return <div className="week-day" key={day.id}><strong>{day.text}</strong>{slots.map(slot =>
          <button type="button" className="slot" key={slot.time} title="Убрать" aria-label={`Убрать ${day.text} ${slot.time}`} onClick={() => change({ slots: current.slots.filter(item => !(item.dayOfWeek === day.id && item.time === slot.time)) })}>{slot.time}<X size={12} /></button>)}
          {!slots.length && <span className="muted">—</span>}
        </div>;
      })}</div>
      <div className="slot-adder">
        <label>Время<input type="time" value={time} onChange={event => setTime(event.target.value)} /></label>
        <div className="day-toggles" role="group" aria-label="Дни недели">{DAYS.map(day => <button key={day.id} type="button" aria-pressed={days.includes(day.id)} onClick={() => setDays(value => value.includes(day.id) ? value.filter(item => item !== day.id) : [...value, day.id])}>{day.text}</button>)}</div>
        <button type="button" className="ghost" disabled={!time || !days.length} onClick={add}><Plus size={15} />Добавить</button>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="panel-foot">
        <span className="muted">{queue?.active && queue.nextSlots[0] ? `Следующий слот: ${formatDate(queue.nextSlots[0])}` : 'Следующего слота нет'}</span>
        <button className="primary" disabled={saving || !draft || !current.slots.length} onClick={() => void save()}>{saving && <Loader2 size={15} className="spin" />}Сохранить расписание</button>
      </div>
    </div>
  </section>;
}
