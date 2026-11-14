"use client";
/**
 * «Активность»: replies and comments under the posts FERMA published, with an answer the AI suggests and the owner
 * edits and sends; what needs attention; and the history of one account. Nothing is answered without the owner.
 */
import { useState } from 'react';
import { AlertCircle, ExternalLink, Send, X } from 'lucide-react';
import { ErrorLine, Loading, metricsLine, send, Spin, useAction, useApi } from './content-ui';
import { Empty, formatDate, Network, Segmented, StatusPill, type Ctx } from './shared';

type Task = { id: string; accountId: string; username: string | null; platform: string | null; kind: string; author: string | null; text: string | null; status: string; receivedAt: string; suggestion: string | null; reply: string | null; repliedAt: string | null; error: string | null; post: string | null; permalink: string | null };
type Activity = {
  waiting: number; answeredToday: number;
  accounts: { id: string; platform: string; username: string | null; status: string; profileId: string }[];
  notifications: { kind: string; at: string | null; text: string; id: string }[];
  tasks: Task[];
  history: { id: string; status: string; at: string; text: string; permalink: string | null; stats: Record<string, number> | null; error: string | null; title: string | null }[];
};
type Filter = 'waiting' | 'answered' | 'all';
const TASK_STATUS: Record<string, [string, string]> = { new: ['Новый', 'info'], suggested: ['Есть черновик ответа', 'info'], sending: ['Отправляется', 'info'], sent: ['Отвечено', 'good'], failed: ['Не отправлен', 'bad'], ignored: ['Без ответа', 'plain'] };
const LIMITS: Record<string, number> = { threads: 500, instagram: 2200 };

function TaskCard({ ctx, task, onChanged }: { ctx: Ctx; task: Task; onChanged: () => void }) {
  const [text, setText] = useState(task.reply || task.suggestion || '');
  const action = useAction(ctx);
  const open = ['new', 'suggested', 'failed'].includes(task.status);
  const limit = LIMITS[task.platform || 'threads'];
  return <li className="activity-item">
    <div className="post-text">
      <span className="field-row"><Network platform={task.platform || 'threads'} username={task.username} /><span className={`pill ${TASK_STATUS[task.status]?.[1] || 'plain'}`}>{TASK_STATUS[task.status]?.[0] || task.status}</span><time className="muted">{formatDate(task.receivedAt)}</time></span>
      {task.post && <small className="muted">Пост: {task.post}</small>}
      <strong className="wrap">{task.author ? `@${task.author}: ` : ''}{task.text}</strong>
      {task.status === 'sent' && task.reply && <small className="wrap">Ваш ответ: {task.reply}</small>}
      {task.error && <small className={task.status === 'failed' ? 'error-text' : 'muted'}>{task.error}</small>}
    </div>
    {open && <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.run('send', async () => { await send('/api/activity', { action: 'send', id: task.id, text }); onChanged(); }, task.platform === 'threads' ? 'Ответ создан, через полминуты он выйдет в Threads.' : 'Ответ отправлен.'); }}>
      <label>Ответ<textarea rows={3} maxLength={limit} value={text} placeholder={task.status === 'new' ? 'ИИ ещё не предложил ответ. Можно написать свой.' : 'Напишите ответ'} onChange={event => setText(event.target.value)} /></label>
      <span className="field-row"><small className="muted">{text.length} из {limit}</small><span className="grow" />
        <button type="button" className="ghost small" disabled={Boolean(action.busy)} onClick={() => void action.run('ignore', async () => { await send('/api/activity', { action: 'ignore', id: task.id }); onChanged(); })}><X size={14} />Без ответа</button>
        <button className="primary small" disabled={Boolean(action.busy) || !text.trim()}><Spin on={action.busy === 'send'}><Send size={14} /></Spin>Отправить</button></span>
      <ErrorLine text={action.error} />
    </form>}
    {task.permalink && <a className="link" href={task.permalink} target="_blank" rel="noreferrer"><ExternalLink size={13} />Открыть пост</a>}
  </li>;
}

export function ActivityView({ ctx }: { ctx: Ctx }) {
  const [accountId, setAccountId] = useState('');
  const [filter, setFilter] = useState<Filter>('waiting');
  const view = useApi<Activity>(`/api/activity${accountId ? `?accountId=${accountId}` : ''}`, 30000);
  const action = useAction(ctx);
  const data = view.data;
  if (view.loading && !data) return <Loading />;
  if (!data) return <ErrorLine text={view.error} />;
  const tasks = data.tasks.filter(task => filter === 'all' || (filter === 'waiting' ? ['new', 'suggested', 'failed', 'sending'].includes(task.status) : task.status === 'sent'));
  return <div className="stack">
    <ErrorLine text={view.error || action.error} />
    {data.notifications.length > 0 && <section className="panel"><header className="panel-head"><h2>Требует внимания</h2></header><ul className="plain-list">{data.notifications.map(item => <li key={`${item.kind}:${item.id}`}>
      <span className="attention"><AlertCircle size={15} /><span>{item.text}</span></span>{item.at && <time>{formatDate(item.at)}</time>}
      <button className="link" onClick={() => ctx.go(item.kind === 'account' ? 'accounts' : 'posts')}>{item.kind === 'account' ? 'Аккаунты' : 'Публикации'}</button>
    </li>)}</ul></section>}
    <div className="toolbar">
      <Segmented label="Комментарии" value={filter} onChange={setFilter} options={[{ id: 'waiting', text: 'Ждут ответа', count: data.waiting }, { id: 'answered', text: 'Отвечено', count: data.tasks.filter(task => task.status === 'sent').length }, { id: 'all', text: 'Все', count: data.tasks.length }]} />
      <select className="compact-select" aria-label="Аккаунт" value={accountId} onChange={event => setAccountId(event.target.value)}><option value="">Все аккаунты</option>{data.accounts.map(account => <option key={account.id} value={account.id}>@{account.username} ({account.platform === 'threads' ? 'Threads' : 'Instagram'})</option>)}</select>
      <span className="toolbar-note">Отвечено за сутки: {data.answeredToday}. Новые комментарии FERMA читает раз в полчаса.</span>
    </div>
    {tasks.length ? <section className="panel"><ul className="plain-list activity-list">{tasks.map(task => <TaskCard key={task.id} ctx={ctx} task={task} onChanged={() => void view.reload()} />)}</ul></section>
      : <Empty title={filter === 'waiting' ? 'Новых комментариев нет' : 'Здесь пусто'} text={data.accounts.length ? 'Здесь появятся комментарии под публикациями FERMA за последние 7 дней.' : 'Подключите аккаунты Threads и Instagram в «Аккаунтах»: здесь появятся комментарии под публикациями FERMA.'} />}
    {accountId && <section className="panel"><header className="panel-head"><h2>История аккаунта</h2></header>{data.history.length ? <div className="table-scroll"><table>
      <thead><tr><th>Публикация</th><th>Когда</th><th>Статус</th><th /></tr></thead>
      <tbody>{data.history.map(row => <tr key={row.id}>
        <td><span className="post-text"><strong>{row.title || row.text.slice(0, 80)}</strong>{row.stats && <small className="muted">{metricsLine(row.stats)}</small>}{row.error && <small className="error-text">{row.error}</small>}</span></td>
        <td className="nowrap">{formatDate(row.at)}</td><td><StatusPill status={row.status} /></td>
        <td className="row-actions">{row.permalink && <a className="icon-button" href={row.permalink} target="_blank" rel="noreferrer" title="Открыть пост" aria-label="Открыть пост"><ExternalLink size={15} /></a>}</td>
      </tr>)}</tbody>
    </table></div> : <div className="panel-body"><p className="muted">Публикаций FERMA в этом аккаунте пока нет.</p></div>}</section>}
    <p className="muted small-note">Ответ уходит только после «Отправить», ровно с вашим текстом. Личные сообщения в FERMA не подключены: Meta отдаёт их только через отдельное разрешение и вебхуки.</p>
  </div>;
}
