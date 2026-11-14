"use client";
/**
 * «Публикации»: FERMA's own queue (Threads and Instagram through the owner's Meta apps) with the switch, the stop
 * button, approvals and new times; and, on its own tab, the Zernio posts and queues that work as before.
 */
import { useState } from 'react';
import { CalendarClock, Check, ExternalLink, Eye, FileText, Images, OctagonX, Plus, RefreshCw, RotateCcw, UploadCloud, X } from 'lucide-react';
import { STYLE_NAMES, type Style } from '@/lib/content/plan';
import { ErrorLine, FORMAT_NAMES, fromLocalInput, Loading, metricsLine, send, Spin, toLocalInput, useAction, useApi } from './content-ui';
import { Empty, formatDate, Modal, Network, Segmented, StatusPill, type Ctx } from './shared';
import { PostsPanel, QueueOverview } from './view-posts';

type QueueRow = { source: string; id: string; profileId: string; profile: string; platform: string; account: string | null; status: string; at: string; title: string; text: string; kind: string | null; style: string | null; layout: string | null; format: string; error: string | null; permalink: string | null; stats: Record<string, number> | null; mediaCount: number };
type QueueData = { autopublish: boolean; publicBaseUrl: string | null; running: { campaigns: number; autopilots: number; zernioWaiting: number }; rows: QueueRow[] };
type Filter = 'all' | 'approval' | 'scheduled' | 'work' | 'published' | 'problem';
const GROUPS: Record<Filter, string[]> = { all: [], approval: ['awaiting_approval', 'draft'], scheduled: ['scheduled'], work: ['preparing', 'processing', 'publishing', 'uncertain'], published: ['published'], problem: ['failed', 'uncertain'] };

function EventsModal({ id, close }: { id: string; close: () => void }) {
  const view = useApi<{ events: { id: string; at: string; level: string; message: string }[] }>(`/api/publications?events=${id}`);
  return <Modal title="История публикации" close={close} wide><div className="form-body">{view.data?.events.length
    ? <ul className="plain-list">{view.data.events.map(event => <li key={event.id}><time>{formatDate(event.at)}</time><span className={event.level === 'error' ? 'error-text' : event.level === 'warn' ? '' : 'muted'}>{event.message}</span></li>)}</ul>
    : view.loading ? <Loading /> : <p className="muted">Событий пока нет.</p>}</div></Modal>;
}

function StopModal({ ctx, running, close, onDone }: { ctx: Ctx; running: QueueData['running']; close: () => void; onDone: () => void }) {
  const [zernio, setZernio] = useState(running.zernioWaiting > 0);
  const action = useAction(ctx);
  return <Modal title="Остановить все публикации?" close={close}>
    <div className="form-body stack">
      <ul className="plain-list">
        <li><span>Автопубликация FERMA выключится: ни одна публикация не уйдёт в Threads и Instagram, пока вы её не включите.</span></li>
        <li><span>Кампании встанут на паузу{running.campaigns ? ` (работает сейчас: ${running.campaigns})` : ''}, новые материалы не будут раздаваться.</span></li>
        <li><span>Автопилоты профилей встанут на паузу{running.autopilots ? ` (включено сейчас: ${running.autopilots})` : ''}.</span></li>
      </ul>
      {running.zernioWaiting > 0 && <label className="switch"><input type="checkbox" checked={zernio} onChange={event => setZernio(event.target.checked)} />Отменить и публикации автопилота, уже переданные в Zernio ({running.zernioWaiting}): иначе они выйдут в своё время</label>}
      <small className="muted">Публикация, которая отправляется прямо сейчас, уже не останавливается: FERMA сверит её с соцсетью, как обычно.</small>
      <ErrorLine text={action.error} />
    </div>
    <div className="modal-footer"><button className="ghost" onClick={close}>Отмена</button><button className="danger" disabled={Boolean(action.busy)} onClick={() => void action.run('stop', async () => {
      const result = await send<{ campaigns: number; autopilots: number; zernioTakenBack: number; zernioWaiting: number; errors: string[] }>('/api/publications', { action: 'stopAll', zernio });
      onDone(); close();
      ctx.notify(`Остановлено. Кампаний на паузе: ${result.campaigns}, автопилотов: ${result.autopilots}${result.zernioTakenBack ? `, отменено в Zernio: ${result.zernioTakenBack}` : ''}${result.errors.length ? `. Не отменились в Zernio: ${result.zernioWaiting} (${result.errors[0]})` : ''}.`);
    })}><Spin on={action.busy === 'stop'}><OctagonX size={15} /></Spin>Остановить всё</button></div>
  </Modal>;
}

function RescheduleModal({ ctx, row, close, onDone }: { ctx: Ctx; row: QueueRow; close: () => void; onDone: () => void }) {
  const [at, setAt] = useState(toLocalInput(row.at));
  const action = useAction(ctx);
  return <Modal title="Другое время" close={close}>
    <form onSubmit={event => { event.preventDefault(); void action.run('move', async () => { await send('/api/publications', { action: 'reschedule', id: row.id, at: fromLocalInput(at) }); onDone(); close(); }, 'Время изменено.'); }}>
      <div className="form-body form-stack">
        <p><strong>{row.title}</strong><br /><span className="muted">{row.profile} · @{row.account}</span></p>
        <label>Дата и время по Кызылорде<input required type="datetime-local" value={at} onChange={event => setAt(event.target.value)} /></label>
        <small className="muted">Новость выходит, пока она свежая: позже срока из настроек FERMA её не поставит.</small>
        <ErrorLine text={action.error} />
      </div>
      <div className="modal-footer"><button type="button" className="ghost" onClick={close}>Отмена</button><button className="primary" disabled={Boolean(action.busy)}><Spin on={action.busy === 'move'}><Check size={15} /></Spin>Сохранить</button></div>
    </form>
  </Modal>;
}

function FermaQueue({ ctx }: { ctx: Ctx }) {
  const view = useApi<QueueData>('/api/publications', 15000);
  const action = useAction(ctx);
  const [filter, setFilter] = useState<Filter>('all');
  const [events, setEvents] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [moving, setMoving] = useState<QueueRow | null>(null);
  const data = view.data;
  if (view.loading && !data) return <Loading text="Загружаем очередь…" />;
  const own = (data?.rows || []).filter(row => row.source === 'ferma');
  const rows = own.filter(row => filter === 'all' || GROUPS[filter].includes(row.status));
  const count = (value: Filter) => own.filter(row => value === 'all' || GROUPS[value].includes(row.status)).length;
  const awaiting = own.filter(row => row.status === 'awaiting_approval');
  const act = (id: string, body: Record<string, unknown>, done: string) => action.run(id, async () => { await send('/api/publications', body); await view.reload(); }, done);
  const anyRunning = Boolean(data && (data.autopublish || data.running.campaigns || data.running.autopilots || data.running.zernioWaiting));
  return <div className="stack">
    <section className="panel">
      <header className="panel-head"><h2>Публикации FERMA</h2>
        <div className="panel-actions">
          <label className="switch"><input type="checkbox" checked={Boolean(data?.autopublish)} disabled={Boolean(action.busy)} onChange={event => {
            const on = event.target.checked;
            if (on && !confirm('Включить автопубликацию? Одобренные и автоматические публикации FERMA начнут выходить в Threads и Instagram по расписанию.')) return;
            void action.run('auto', async () => { await send('/api/content', { action: 'settings', autopublish: on }); await view.reload(); }, on ? 'Автопубликация включена.' : 'Автопубликация выключена: ничего не уйдёт, пока вы её не включите.');
          }} />Автопубликация {data?.autopublish ? 'включена' : 'выключена'}</label>
          <button className="danger small" disabled={!anyRunning || Boolean(action.busy)} title={anyRunning ? '' : 'Сейчас ничего не публикуется'} onClick={() => setStopping(true)}><OctagonX size={14} />Остановить всё</button>
        </div>
      </header>
      {!data?.publicBaseUrl && <div className="panel-body"><p className="notice-bad">Не задан публичный адрес FERMA: без него соцсеть не заберёт картинки. <button className="link" onClick={() => ctx.go('settings')}>Настройки</button></p></div>}
    </section>
    <ErrorLine text={view.error || action.error} />
    <div className="toolbar">
      <Segmented label="Статус" value={filter} onChange={setFilter} options={[{ id: 'all', text: 'Все', count: count('all') }, { id: 'approval', text: 'Ждут одобрения', count: count('approval') }, { id: 'scheduled', text: 'Запланированы', count: count('scheduled') }, { id: 'work', text: 'Отправляются', count: count('work') }, { id: 'published', text: 'Опубликованы', count: count('published') }, { id: 'problem', text: 'Ошибки', count: count('problem') }]} />
      {awaiting.length > 0 && <button className="ghost" disabled={Boolean(action.busy)} onClick={() => void act('many', { action: 'approveMany', ids: awaiting.slice(0, 100).map(row => row.id) }, `Одобрено: ${Math.min(100, awaiting.length)}.`)}><Check size={15} />Одобрить все ({awaiting.length})</button>}
      <button className="ghost" disabled={view.loading} onClick={() => void view.reload()}><Spin on={view.loading}><RefreshCw size={15} /></Spin>Обновить</button>
    </div>
    {rows.length ? <section className="panel"><div className="table-scroll"><table className="posts">
      <thead><tr><th>Публикация</th><th>Профиль</th><th>Аккаунт</th><th>Когда</th><th>Статус</th><th /></tr></thead>
      <tbody>{rows.slice(0, 300).map(row => <tr key={row.id}>
        <td><div className="post-cell"><span className="post-icon">{row.mediaCount > 1 ? <Images size={15} /> : <FileText size={15} />}</span><span className="post-text">
          <strong>{row.title || row.text.slice(0, 80) || 'Публикация'}</strong>
          {row.text && <small>{row.text.slice(0, 180)}{row.text.length > 180 ? '…' : ''}</small>}
          <small className="muted">{[FORMAT_NAMES[row.format] || row.format, row.mediaCount > 1 ? `картинок: ${row.mediaCount}` : '', row.style ? STYLE_NAMES[row.style as Style] || row.style : ''].filter(Boolean).join(' · ')}</small>
          {row.error && <small className={row.status === 'scheduled' ? 'muted' : 'error-text'}>{row.error}</small>}
          {row.stats && <small className="muted">{metricsLine(row.stats)}</small>}
        </span></div></td>
        <td>{row.profileId ? <button className="link" onClick={() => ctx.go(`profile/${row.profileId}`)}>{row.profile}</button> : '—'}</td>
        <td className="nowrap"><Network platform={row.platform} username={row.account} /></td>
        <td className="nowrap">{row.at ? formatDate(row.at) : '—'}</td>
        <td><StatusPill status={row.status} /></td>
        <td className="row-actions">
          {['awaiting_approval', 'draft'].includes(row.status) && <button className="ghost small" onClick={() => void act(row.id, { action: 'approve', id: row.id }, 'Одобрено.')}><Check size={14} />Одобрить</button>}
          {['awaiting_approval', 'draft', 'scheduled'].includes(row.status) && <button className="icon-button" title="Другое время" aria-label="Другое время" onClick={() => setMoving(row)}><CalendarClock size={15} /></button>}
          {row.status === 'failed' && <button className="ghost small" onClick={() => void act(row.id, { action: 'retry', id: row.id }, 'Поставлено на повтор.')}><RotateCcw size={14} />Повторить</button>}
          {['draft', 'awaiting_approval', 'scheduled', 'failed', 'processing'].includes(row.status) && <button className="icon-button" title="Отменить" aria-label="Отменить" onClick={() => void act(row.id, { action: 'cancel', id: row.id }, 'Отменено.')}><X size={15} /></button>}
          <button className="icon-button" title="История" aria-label="История" onClick={() => setEvents(row.id)}><Eye size={15} /></button>
          {row.permalink && <a className="icon-button" href={row.permalink} target="_blank" rel="noreferrer" title="Открыть пост" aria-label="Открыть пост"><ExternalLink size={15} /></a>}
        </td>
      </tr>)}</tbody>
    </table></div></section> : <Empty title={own.length ? 'Здесь пусто' : 'Публикаций FERMA пока нет'} text={own.length ? undefined : 'Они появятся, когда активная кампания раздаст материалы по аккаунтам.'} />}
    {events && <EventsModal id={events} close={() => setEvents(null)} />}
    {stopping && data && <StopModal ctx={ctx} running={data.running} close={() => setStopping(false)} onDone={() => void view.reload()} />}
    {moving && <RescheduleModal ctx={ctx} row={moving} close={() => setMoving(null)} onDone={() => void view.reload()} />}
  </div>;
}

export function PublicationsView({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState<'ferma' | 'zernio'>('ferma');
  const withKey = ctx.state.profiles.filter(profile => profile.configured);
  return <div className="stack">
    <Segmented label="Публикации" value={tab} onChange={setTab} options={[{ id: 'ferma', text: 'FERMA: Threads и Instagram' }, { id: 'zernio', text: 'Zernio и автопилот' }]} />
    {tab === 'ferma' ? <FermaQueue ctx={ctx} /> : <>
      <div className="toolbar"><button className="primary" onClick={() => ctx.compose()}><Plus size={16} />Новая публикация</button><button className="ghost" onClick={() => ctx.bulk()}><UploadCloud size={16} />Пачку в очередь</button><span className="toolbar-note">Публикации через Zernio выходят по расписанию Zernio, даже когда компьютер выключен.</span></div>
      <QueueOverview ctx={ctx} profiles={withKey} />
      {ctx.state.profiles.length ? <PostsPanel ctx={ctx} profiles={ctx.state.profiles} /> : <Empty title="Сначала создайте профиль" />}
    </>}
  </div>;
}
