"use client";
/** «Источники»: the connection to Gudini and the materials it sent. */
import { useState } from 'react';
const FIRST = 20;
import { AlertCircle, Pause, Play, Plug, RefreshCw, RotateCcw } from 'lucide-react';
import { bytesText, ErrorLine, KIND_NAMES, Loading, send, Spin, useAction, useApi } from './content-ui';
import { Empty, formatDate, StatusPill, type Ctx } from './shared';

type SourceView = {
  source: null | { baseUrl: string; enabled: boolean; status: string; lastSyncAt: string | null; lastSuccessAt: string | null; lastError: string | null; failures: number; nextSyncAt: string | null; hasCursor: boolean };
  counts: { status: string; kind: string; count: number }[];
  assets: { status: string; count: number; bytes: number }[];
  latest: { id: string; kind: string; title: string; status: string; error: string | null; assetsTotal: number; assetsStored: number; sourceReadyAt: string | null; duplicateOf: string | null; relatedTo: string | null; categories: string[]; urgent: boolean }[];
};

function SourceForm({ ctx, initial, onSaved, onCancel }: { ctx: Ctx; initial: string; onSaved: () => void; onCancel?: () => void }) {
  const [baseUrl, setBaseUrl] = useState(initial || 'http://host.docker.internal:8610');
  const [token, setToken] = useState('');
  const action = useAction(ctx);
  return <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.run('save', async () => { await send('/api/content', { action: 'saveSource', baseUrl, token: token || null }); setToken(''); onSaved(); }, 'Gudini подключён. Материалы начнут приходить сами.'); }}>
    <label>Адрес выгрузки Gudini<input required value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="http://host.docker.internal:8610" /></label>
    <small className="muted">На этом компьютере: http://host.docker.internal:8610 (контейнер gudini-export).</small>
    <label>Токен выгрузки<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder={initial ? 'Сохранён. Введите новый, чтобы заменить' : 'EXPORT_TOKEN из gudini/export/.env'} /></label>
    <ErrorLine text={action.error} />
    <div className="panel-actions"><button className="primary" disabled={Boolean(action.busy)}><Spin on={action.busy === 'save'}><Plug size={15} /></Spin>Проверить и подключить</button>{onCancel && <button type="button" className="ghost" onClick={onCancel}>Отмена</button>}</div>
  </form>;
}

export function SourcesView({ ctx }: { ctx: Ctx }) {
  const view = useApi<SourceView>('/api/content?view=sources', 15000);
  const action = useAction(ctx);
  const [editing, setEditing] = useState(false);
  const [all, setAll] = useState(false);
  const source = view.data?.source;
  if (view.loading && !view.data) return <Loading />;
  const total = (kind?: string, status?: string) => (view.data?.counts || []).filter(row => (!kind || row.kind === kind) && (!status || row.status === status)).reduce((sum, row) => sum + row.count, 0);
  const stored = view.data?.assets.find(row => row.status === 'stored');
  const latest = view.data?.latest || [];
  return <div className="stack">
    <ErrorLine text={view.error || action.error} />
    <section className="panel">
      <header className="panel-head"><h2>Gudini</h2>{source ? <StatusPill status={source.enabled ? source.status : 'paused'} /> : <span className="pill plain">Не подключён</span>}</header>
      <div className="panel-body stack">
        {!source || editing ? <SourceForm ctx={ctx} initial={source?.baseUrl || ''} onSaved={() => { setEditing(false); void view.reload(); }} onCancel={source ? () => setEditing(false) : undefined} /> : <>
          <p><span className="muted">Адрес:</span> {source.baseUrl}</p>
          <p className="muted">Последняя проверка: {source.lastSyncAt ? formatDate(source.lastSyncAt) : '—'}, успешная: {source.lastSuccessAt ? formatDate(source.lastSuccessAt) : '—'}. Новый материал приходит за несколько секунд после готовности в Gudini, ленту FERMA перепроверяет каждые 5 минут.</p>
          {source.lastError && <p className="notice-bad"><AlertCircle size={15} /><span>{source.lastError}{source.failures ? ` Неудачных попыток подряд: ${source.failures}, следующая ${source.nextSyncAt ? formatDate(source.nextSyncAt) : 'скоро'}.` : ''}</span></p>}
          <div className="panel-actions">
            <button className="ghost" disabled={Boolean(action.busy)} onClick={() => void action.run('sync', async () => { await send('/api/content', { action: 'sync', force: true }); await send('/api/content', { action: 'fetchAssets', limit: 10 }); await view.reload(); }, 'Лента проверена.')}><Spin on={action.busy === 'sync'}><RefreshCw size={15} /></Spin>Проверить сейчас</button>
            <button className="ghost" disabled={Boolean(action.busy)} onClick={() => void action.run('toggle', async () => { await send('/api/content', { action: 'sourceEnabled', enabled: !source.enabled }); await view.reload(); }, source.enabled ? 'Загрузка из Gudini остановлена.' : 'Загрузка из Gudini включена.')}>{source.enabled ? <><Pause size={15} />Остановить</> : <><Play size={15} />Включить</>}</button>
            <button className="link" onClick={() => setEditing(true)}>Изменить подключение</button>
          </div>
        </>}
      </div>
    </section>
    {source && <div className="tiles">
      {[['Новости', 'news'], ['Карусели', 'carousel'], ['Видеокарусели', 'video_carousel']].map(([label, kind]) => <div className="tile" key={kind}><span>{label}</span><strong>{total(kind, 'ready')}</strong><small>готово из {total(kind)}</small></div>)}
      <div className="tile"><span>Загружается</span><strong>{total(undefined, 'importing')}</strong><small>с ошибкой: {total(undefined, 'failed')}</small></div>
      <div className="tile"><span>Файлы Gudini</span><strong>{stored?.count || 0}</strong><small>{stored ? `${bytesText(stored.bytes)}, без изменений` : 'пока нет'}</small></div>
    </div>}
    {latest.length ? <section className="panel"><header className="panel-head"><h2>Последние материалы</h2></header><div className="table-scroll"><table>
      <thead><tr><th>Материал</th><th>Вид</th><th>Темы</th><th>Готов в Gudini</th><th className="num">Файлы</th><th>Статус</th><th /></tr></thead>
      <tbody>{(all ? latest : latest.slice(0, FIRST)).map(item => <tr key={item.id}>
        <td><span className="post-text"><strong>{item.title}</strong>{item.relatedTo && <small className="muted">другая версия уже пришедшей истории</small>}{item.error && <small className="error-text">{item.error}</small>}</span></td>
        <td className="nowrap">{KIND_NAMES[item.kind] || item.kind}</td>
        <td>{item.categories.length || item.urgent ? <small>{[item.urgent ? 'срочно' : '', ...item.categories].filter(Boolean).join(', ')}</small> : <span className="muted">—</span>}</td>
        <td className="nowrap">{item.sourceReadyAt ? formatDate(item.sourceReadyAt) : '—'}</td>
        <td className="num nowrap">{item.assetsStored} из {item.assetsTotal}</td>
        <td><StatusPill status={item.status} /></td>
        <td className="row-actions">
          {item.status === 'failed' && <button className="ghost small" onClick={() => void action.run(item.id, async () => { await send('/api/content', { action: 'retryItem', itemId: item.id }); await view.reload(); }, 'Загрузка материала повторяется.')}><RotateCcw size={14} />Повторить</button>}
          {item.status === 'ready' && <button className="link" onClick={() => ctx.go(`variants/${item.id}`)}>Варианты</button>}
          {['ready', 'failed', 'ignored'].includes(item.status) && <button className="link spaced" onClick={() => void action.run(item.id, async () => { await send('/api/content', { action: 'ignoreItem', itemId: item.id, ignored: item.status !== 'ignored' }); await view.reload(); })}>{item.status === 'ignored' ? 'Вернуть' : 'Скрыть'}</button>}
        </td>
      </tr>)}</tbody>
    </table></div>{latest.length > FIRST && <div className="panel-note"><button className="link" onClick={() => setAll(value => !value)}>{all ? 'Показать последние 20' : `Показать все (${latest.length})`}</button></div>}</section> : source && <Empty title="Материалов пока нет" text="Как только в Gudini будет готова новость или карусель, она придёт сюда сама." />}
  </div>;
}
