"use client";
import { useEffect, useState } from 'react';
import { Loader2, Pause, Play, SkipForward } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import { formatDate, type Ctx, type Profile } from './shared';

type Item = { id: string; kind: string; status: string; dueAt: string; text: string | null; hasImage: boolean; extraImages: number; error: string | null; attempts: number };
type KindRhythm = { minDays: number; maxDays: number; perDay?: number | null };
type State = { tgChannel: string | null; rhythm: Record<string, KindRhythm> | null; persona: Record<string, unknown> | null; enabled: boolean; engine: { heartbeatAt: string; bridgeOk: boolean; note: string | null } | null; items: Item[] };
const KIND: Record<string, string> = { threads: 'Threads', story: 'Сторис', post: 'Пост в Instagram', reel: 'Пробный рилс' };
const STATUS: Record<string, [string, string]> = {
  planned: ['Запланировано', 'plain'], generating: ['Генерируется', 'info'], ready: ['Готово', 'info'], scheduled: ['Передано в Zernio', 'info'],
  stock: ['В запасе', 'plain'], published: ['Опубликовано', 'good'], failed: ['Ошибка', 'bad'], skipped: ['Пропущено', 'plain'],
};
const post = <T,>(body: unknown) => requestJson<T>('/api/autopilot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const RHYTHM_ROWS: [string, string][] = [['threads', 'Пост в Threads'], ['story', 'Сторис'], ['post', 'Пост в Instagram'], ['reel', 'Пробный рилс']];
type Draft = { mode: 'day' | 'days'; perDay: number; minDays: number; maxDays: number };
function RhythmForm({ profileId, rhythm, tgChannel, onSaved }: { profileId: string; rhythm: Record<string, KindRhythm>; tgChannel: string | null; onSaved: () => void }) {
  const [values, setValues] = useState<Record<string, Draft>>(() => Object.fromEntries(RHYTHM_ROWS.filter(([kind]) => rhythm[kind]).map(([kind]) => [kind, { mode: rhythm[kind].perDay ? 'day' : 'days', perDay: rhythm[kind].perDay || 1, minDays: rhythm[kind].minDays, maxDays: rhythm[kind].maxDays }])));
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const change = (kind: string, patch: Partial<Draft>) => { setValues(current => ({ ...current, [kind]: { ...current[kind], ...patch } })); setNote(''); setError(''); };
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setNote('');
    try {
      const body = Object.fromEntries(RHYTHM_ROWS.filter(([kind]) => values[kind]).map(([kind]) => [kind, values[kind].mode === 'day' ? { perDay: values[kind].perDay } : { minDays: values[kind].minDays, maxDays: values[kind].maxDays }]));
      await post({ action: 'rhythm', profileId, rhythm: body });
      setNote('Сохранено. Действует со следующих публикаций.'); onSaved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить.'); }
    finally { setSaving(false); }
  }
  return <form className="rhythm-form" onSubmit={save}>
    {RHYTHM_ROWS.filter(([kind]) => values[kind]).map(([kind, label]) => {
      const value = values[kind];
      if (kind === 'threads' && tgChannel) return <div className="rhythm-row" key={kind}><span>{label}</span><span className="muted">из канала @{tgChannel}, сразу после выхода</span></div>;
      return <div className="rhythm-row" key={kind}>
        <span>{label}</span>
        <select value={value.mode} disabled={saving} aria-label={`${label}: как часто`} onChange={event => change(kind, { mode: event.target.value as Draft['mode'] })}>
          <option value="day">несколько раз в день</option>
          <option value="days">раз в несколько дней</option>
        </select>
        {value.mode === 'day'
          ? <label><input type="number" min={1} max={12} required value={value.perDay} disabled={saving} onChange={event => change(kind, { perDay: Number(event.target.value) })} aria-label={`${label}: раз в день`} /> раз в день</label>
          : <label>раз в <input type="number" min={1} max={90} required value={value.minDays} disabled={saving} onChange={event => change(kind, { minDays: Number(event.target.value) })} aria-label={`${label}: от, дней`} /> – <input type="number" min={1} max={90} required value={value.maxDays} disabled={saving} onChange={event => change(kind, { maxDays: Number(event.target.value) })} aria-label={`${label}: до, дней`} /> дн.</label>}
      </div>;
    })}
    <p className="muted small-note">Несколько раз в день: публикации расходятся по времени с 9 до 23 часов её города, промежутки неровные. Раз в несколько дней: «1 – 1» это каждый день. Пробные рилсы Instagram разрешает только с 1000 подписчиков: до этого они не выходят, потом включаются сами.</p>
    {error && <p className="error-text" role="alert">{error}</p>}
    {note && <p className="key-saved" role="status">{note}</p>}
    <button className="primary small" style={{ justifySelf: 'start' }} disabled={saving}>Сохранить регулярность</button>
  </form>;
}
export function AutopilotPanel({ profile }: { profile: Profile; ctx: Ctx }) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [checkedAt, setCheckedAt] = useState(0);
  const [showStock, setShowStock] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const load = () => requestJson<State>(`/api/autopilot?profileId=${profile.id}`).then(data => { setState(data); setCheckedAt(Date.now()); }).catch(failure => setError(failure.message));
  useEffect(() => {
    // The plan changes on its own, so the page follows it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);
  async function act(key: string, body: unknown) {
    setBusy(key); setError('');
    try { await post(body); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка.'); }
    finally { setBusy(''); }
  }
  if (!state) return <section className="panel"><div className="panel-body">{error ? <p className="error-text">{error}</p> : <p className="muted"><Loader2 size={14} className="spin" /> Загружаем…</p>}</div></section>;
  if (!state.persona) return <section className="panel"><div className="panel-body"><p className="muted">Личность ещё не создана. Она появится сама в течение пары минут после того, как у профиля есть ключ Zernio и подключён Instagram или Threads. Для этого должен быть на связи GPT-мост.</p></div></section>;
  const persona = state.persona as Record<string, string | number | string[]>;
  const engineAge = state.engine ? Math.max(0, Math.round((checkedAt - Date.parse(state.engine.heartbeatAt)) / 60000)) : null;
  const engineOk = engineAge !== null && engineAge < 5;
  const upcoming = state.items.filter(item => ['planned', 'generating', 'ready', 'scheduled'].includes(item.status)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const stock = state.items.filter(item => item.status === 'stock');
  const history = state.items.filter(item => !upcoming.includes(item) && item.status !== 'stock');
  const row = (item: Item) => <li key={item.id} className="autopilot-item">
    {item.hasImage ? (item.kind === 'reel'
      // Muted, no autoplay: the first frame is the preview; a click opens the video in a new tab.
      ? <a href={`/api/autopilot?image=${item.id}`} target="_blank" rel="noreferrer" title="Открыть видео"><video src={`/api/autopilot?image=${item.id}`} muted playsInline preload="metadata" className="autopilot-video" /></a>
      : <img src={`/api/autopilot?image=${item.id}`} alt="" loading="lazy" />) : <span className="autopilot-thumb">{item.kind === 'threads' ? 'Aa' : item.kind === 'reel' ? '▶' : '…'}</span>}
    <div className="post-text">
      <strong>{item.extraImages > 0 ? `Карусель, ${item.extraImages + 1} фото` : KIND[item.kind] || item.kind}{item.status === 'stock' ? '' : ` · ${formatDate(item.dueAt)}`}</strong>
      {item.text && <small className="wrap">{item.text}</small>}
      {item.error && <small className="error-text">{item.error}</small>}
    </div>
    <span className={`pill ${STATUS[item.status]?.[1] || 'plain'}`}>{STATUS[item.status]?.[0] || item.status}</span>
    {item.status === 'scheduled' && <button className="ghost small" disabled={Boolean(busy)} onClick={() => { if (window.confirm('Отменить эту публикацию в Zernio?')) void act(item.id, { action: 'cancel', id: item.id }); }}>Отменить</button>}
    {['planned', 'ready', 'failed', 'stock'].includes(item.status) && <button className="icon-button" title="Пропустить" aria-label="Пропустить" disabled={Boolean(busy)} onClick={() => void act(item.id, { action: 'skip', id: item.id })}><SkipForward size={15} /></button>}
  </li>;
  return <div className="columns">
    <div className="stack">
      <section className="panel">
        <header className="panel-head"><h2>Автопилот</h2>
          <button className={state.enabled ? 'ghost small' : 'primary small'} disabled={Boolean(busy)} onClick={() => void act('toggle', { action: 'enabled', profileId: profile.id, enabled: !state.enabled })}>
            {busy === 'toggle' ? <Loader2 size={14} className="spin" /> : state.enabled ? <Pause size={14} /> : <Play size={14} />}{state.enabled ? 'Пауза' : 'Включить'}
          </button>
        </header>
        <div className="panel-body">
          <p><span className={`pill ${state.enabled ? 'good' : 'plain'}`}>{state.enabled ? 'Работает сам' : 'На паузе'}</span>{' '}
            <span className={`pill ${engineOk && state.engine?.bridgeOk ? 'good' : 'bad'}`}>{!state.engine ? 'Движок ещё не запускался' : !engineOk ? `Движок молчит ${engineAge} мин` : state.engine.bridgeOk ? 'GPT-мост на связи' : 'GPT-мост не отвечает'}</span></p>
          {state.engine?.note && <p className="notice-bad">{state.engine.note}</p>}
          <p className="muted small-note">Публикация готовится за несколько часов и уходит в Zernio со своим временем, поэтому выходит, даже если компьютер в этот момент выключен. Рисовать и писать мост может, только пока компьютер включён.</p>
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
      </section>
      {state.rhythm && <section className="panel"><header className="panel-head"><h2>Регулярность</h2></header><div className="panel-body"><RhythmForm key={JSON.stringify([state.rhythm, state.tgChannel])} profileId={profile.id} rhythm={state.rhythm} tgChannel={state.tgChannel} onSaved={() => void load()} /></div></section>}
      <section className="panel">
        <header className="panel-head"><h2>Дальше по плану</h2></header>
        {upcoming.length ? <ul className="plain-list autopilot-list">{upcoming.map(row)}</ul> : <div className="panel-body"><p className="muted">{state.enabled ? 'Движок скоро составит план.' : 'Включите автопилот.'}</p></div>}
      </section>
      {stock.length > 0 && <section className="panel"><header className="panel-head"><h2>Запас: выйдет по регулярности</h2><span className="muted">{stock.length}</span></header><ul className="plain-list autopilot-list">{(showStock ? stock : stock.slice(0, 5)).map(row)}</ul>
        {stock.length > 5 && <div className="panel-note"><button className="link" onClick={() => setShowStock(value => !value)}>{showStock ? 'Свернуть' : `Показать весь запас (${stock.length})`}</button></div>}</section>}
      {history.length > 0 && <section className="panel"><header className="panel-head"><h2>История</h2></header><ul className="plain-list autopilot-list">{(showHistory ? history : history.slice(0, 10)).map(row)}</ul>
        {history.length > 10 && <div className="panel-note"><button className="link" onClick={() => setShowHistory(value => !value)}>{showHistory ? 'Свернуть' : `Показать всю историю (${history.length})`}</button></div>}</section>}
    </div>
    <section className="panel">
      <header className="panel-head"><h2>Личность</h2></header>
      <div className="panel-body persona">
        <p><strong>{String(persona.name)}, {String(persona.age)}</strong> · {String(persona.city)} · {String(persona.occupation)}</p>
        {persona.background && <p>{String(persona.background)}</p>}
        {Array.isArray(persona.interests) && <p><span className="muted">Интересы:</span> {persona.interests.join(', ')}</p>}
        {persona.voice && <p><span className="muted">Как пишет:</span> {String(persona.voice)}</p>}
        {persona.visual && <p><span className="muted">Фото:</span> {String(persona.visual)}</p>}
      </div>
    </section>
  </div>;
}
