"use client";
/** «Состояние системы»: FERMA's processes, what the container has left, the queues and every failure with a repeat. */
import { RefreshCw, RotateCcw } from 'lucide-react';
import { bytesText, ErrorLine, Loading, send, Spin, useAction, useApi } from './content-ui';
import { formatDate, Network, statusNames, type Ctx } from './shared';

type Beat = { heartbeatAt: string; ageSeconds: number; ok: boolean; note: string | null; details: Record<string, unknown> | null } | null;
type Resources = { mode: 'normal' | 'busy' | 'disk_low'; cpuLimit: number; ownCpuPercent: number | null; machineLoad: number; cpus: number; ioWaitPercent?: number | null; memAvailableMb: number; memTotalMb: number; appMemoryMb: number; appMemoryLimitMb: number | null; diskFreeGb: number | null; diskTotalGb: number | null };
type System = {
  at: string;
  processes: { engine: Beat; media: Beat; autopilot: { heartbeatAt: string; ageSeconds: number; bridgeOk: boolean; note: string | null } | null };
  source: { status: string; enabled: boolean; lastSyncAt: string | null; lastSuccessAt: string | null; lastError: string | null; failures: number; nextSyncAt: string | null } | null;
  counts: Record<'items' | 'variants' | 'publications' | 'mediaJobs', Record<string, number>>;
  storage: { originals: { files: number; bytes: number }; drawn: { files: number; bytes: number }; retentionDays: number };
  autopublish: boolean;
  problems: {
    publications: { id: string; platform: string; error: string | null; errorKind: string | null; at: string; title: string | null; username: string | null }[];
    items: { id: string; title: string; error: string | null; at: string }[];
    versions: { id: string; status: string; error: string | null; at: string; title: string | null; slot: number }[];
    accounts: { id: string; platform: string; username: string | null; error: string | null; pausedUntil: string | null; tokenExpiresAt: string | null; problem: 'expired' | 'error' | 'paused' | 'token' }[];
  };
};
const MODE: Record<Resources['mode'], [string, string]> = { normal: ['Ресурсов хватает', 'good'], busy: ['Мало ресурсов: необязательное ждёт', 'info'], disk_low: ['Мало места на диске', 'bad'] };
const countLine = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([status, count]) => `${statusNames[status] || status}: ${count}`).join(', ') || 'пусто';

function ProcessRow({ title, beat, healthyAfter = 180 }: { title: string; beat: Beat; healthyAfter?: number }) {
  const alive = Boolean(beat) && beat!.ageSeconds < healthyAfter;
  return <li><span className="post-text"><strong>{title}</strong><small className="muted">{beat ? `последний сигнал ${formatDate(beat.heartbeatAt)}` : 'сигналов ещё не было'}</small>{beat?.note && <small className={beat.ok ? 'muted' : 'error-text'}>{beat.note}</small>}</span>
    <span className={`pill ${alive && beat?.ok ? 'good' : 'bad'}`}>{!beat ? 'Нет сигнала' : !alive ? `Молчит ${Math.round(beat.ageSeconds / 60)} мин` : beat.ok ? 'Работает' : 'Есть ошибки'}</span></li>;
}

export function SystemView({ ctx }: { ctx: Ctx }) {
  const view = useApi<System>('/api/system', 20000);
  const action = useAction(ctx);
  const data = view.data;
  if (view.loading && !data) return <Loading />;
  if (!data) return <ErrorLine text={view.error} />;
  const details = data.processes.engine?.details as { resources?: Resources; paused?: string[]; starts?: { last: string | null; day: number }; backups?: { name: string; at: string | null; before: string[]; ok: boolean }[]; lastCleanup?: { at: string; files: number; bytes: number } | null; startedAt?: string } | null;
  const resources = details?.resources;
  const retry = (key: string, url: string, body: Record<string, unknown>, done: string) => action.run(key, async () => { await send(url, body); await view.reload(); }, done);
  const problems = data.problems.publications.length + data.problems.items.length + data.problems.versions.length + data.problems.accounts.length;
  return <div className="stack">
    <ErrorLine text={view.error || action.error} />
    <div className="toolbar"><span className="toolbar-note">Обновлено {formatDate(data.at)}. Страница обновляется сама каждые 20 секунд.</span><button className="ghost" disabled={view.loading} onClick={() => void view.reload()}><Spin on={view.loading}><RefreshCw size={15} /></Spin>Обновить</button></div>
    <div className="columns">
      <section className="panel"><header className="panel-head"><h2>Процессы</h2></header><ul className="plain-list">
        <ProcessRow title="Контент-движок" beat={data.processes.engine} />
        <ProcessRow title="Медиа-воркер" beat={data.processes.media} />
        <li><span className="post-text"><strong>Автопилот профилей</strong><small className="muted">{data.processes.autopilot ? `последний сигнал ${formatDate(data.processes.autopilot.heartbeatAt)}` : 'сигналов ещё не было'}</small>{data.processes.autopilot?.note && <small className="muted">{data.processes.autopilot.note}</small>}</span>
          <span className={`pill ${data.processes.autopilot && data.processes.autopilot.ageSeconds < 300 && data.processes.autopilot.bridgeOk ? 'good' : 'bad'}`}>{!data.processes.autopilot ? 'Нет сигнала' : data.processes.autopilot.ageSeconds >= 300 ? `Молчит ${Math.round(data.processes.autopilot.ageSeconds / 60)} мин` : data.processes.autopilot.bridgeOk ? 'GPT-мост на связи' : 'GPT-мост не отвечает'}</span></li>
        <li><span className="post-text"><strong>Gudini</strong><small className="muted">{data.source ? `успешная проверка ${data.source.lastSuccessAt ? formatDate(data.source.lastSuccessAt) : '—'}` : 'не подключён'}</small>{data.source?.lastError && <small className="error-text">{data.source.lastError}</small>}</span>
          <span className={`pill ${data.source?.enabled && data.source.status !== 'error' ? 'good' : data.source ? 'bad' : 'plain'}`}>{!data.source ? 'Не подключён' : !data.source.enabled ? 'Остановлен' : data.source.status === 'error' ? `Ошибка, попыток: ${data.source.failures}` : 'На связи'}</span></li>
      </ul>
      {details?.starts && <div className="panel-note"><small className="muted">FERMA запущена {details.starts.last ? formatDate(details.starts.last) : '—'}; запусков за сутки: {details.starts.day}.</small></div>}</section>
      <section className="panel"><header className="panel-head"><h2>Ресурсы</h2>{resources && <span className={`pill ${MODE[resources.mode][1]}`}>{MODE[resources.mode][0]}</span>}</header>
        {resources ? <ul className="plain-list">
          <li><span>Процессор FERMA</span><span>{resources.ownCpuPercent === null ? '—' : `${resources.ownCpuPercent}%`} из {resources.cpuLimit} ядер</span></li>
          <li><span>Нагрузка Docker</span><span>{Math.round(resources.machineLoad * 100)}% ({resources.cpus} ядер)</span></li>
          <li><span>Память FERMA</span><span>{resources.appMemoryMb} МБ{resources.appMemoryLimitMb ? ` из ${resources.appMemoryLimitMb}` : ''}; свободно в Docker {resources.memAvailableMb} из {resources.memTotalMb} МБ</span></li>
          <li><span>Диск Docker</span><span>{resources.diskFreeGb === null ? '—' : `свободно ${resources.diskFreeGb} из ${resources.diskTotalGb} ГБ`}</span></li>
          {resources.ioWaitPercent !== null && resources.ioWaitPercent !== undefined && <li><span>Очередь к диску</span><span>{resources.ioWaitPercent}% времени процессы ждут диск</span></li>}
          {details?.paused?.length ? <li><span>Ждут ресурсов</span><span>{details.paused.join(', ')}</span></li> : null}
        </ul> : <div className="panel-body"><p className="muted">Контент-движок ещё не прислал показания.</p></div>}
        <div className="panel-note"><small className="muted">Диск Docker — виртуальный диск на D:, его свободное место может быть больше реального места на D:. Публикации, импорт текстов и тексты идут при любой нагрузке; ждут рисование карточек, хеши картинок, статистика и проверки. Когда диск занят больше 15% времени, они тоже ждут: каждая запись в базу тогда останавливает FERMA на секунды.</small></div></section>
    </div>
    <section className="panel"><header className="panel-head"><h2>Очереди</h2><span className={`pill ${data.autopublish ? 'good' : 'plain'}`}>{data.autopublish ? 'Автопубликация включена' : 'Автопубликация выключена'}</span></header><ul className="plain-list">
      <li><span>Материалы Gudini</span><small>{countLine(data.counts.items)}</small></li>
      <li><span>Варианты</span><small>{countLine(data.counts.variants)}</small></li>
      <li><span>Публикации FERMA</span><small>{countLine(data.counts.publications)}</small></li>
      <li><span>Рисование карточек</span><small>{countLine(data.counts.mediaJobs)}</small></li>
      <li><span>Файлы Gudini</span><small>{data.storage.originals.files} ({bytesText(data.storage.originals.bytes)}), не удаляются</small></li>
      <li><span>Карточки FERMA</span><small>{data.storage.drawn.files ? `${data.storage.drawn.files} (${bytesText(data.storage.drawn.bytes)})` : 'нет'}; хранятся {data.storage.retentionDays} дн.{details?.lastCleanup ? `, последняя очистка ${formatDate(details.lastCleanup.at)}` : ''}</small></li>
    </ul></section>
    <section className="panel"><header className="panel-head"><h2>Ошибки</h2><span className={`pill ${problems ? 'bad' : 'good'}`}>{problems ? `Есть: ${problems}` : 'Нет'}</span></header>
      {problems ? <ul className="plain-list">
        {data.problems.accounts.map(account => <li key={account.id}><span className="post-text"><span className="field-row"><Network platform={account.platform} username={account.username} /></span><small className="error-text">{account.problem === 'expired' ? 'Доступ истёк: подключите аккаунт заново.' : account.problem === 'paused' ? `Соцсеть попросила подождать: публикации ждут до ${formatDate(account.pausedUntil!)}.` : account.problem === 'token' ? `Доступ заканчивается ${formatDate(account.tokenExpiresAt!)}. FERMA продлевает его сама; если продление не прошло, подключите аккаунт заново.` : account.error || 'Проверка аккаунта не прошла.'}</small></span><button className="link" onClick={() => ctx.go('accounts')}>Аккаунты</button></li>)}
        {data.problems.publications.map(row => <li key={row.id}><span className="post-text"><strong>Публикация: {row.title || 'без названия'}</strong><small className="error-text">{row.username ? `@${row.username}: ` : ''}{row.error || 'без причины'}</small><small className="muted">{formatDate(row.at)}</small></span>
          <button className="ghost small" disabled={Boolean(action.busy)} onClick={() => void retry(row.id, '/api/publications', { action: 'retry', id: row.id }, 'Публикация поставлена на повтор.')}><Spin on={action.busy === row.id}><RotateCcw size={14} /></Spin>Повторить</button></li>)}
        {data.problems.items.map(row => <li key={row.id}><span className="post-text"><strong>Материал: {row.title}</strong><small className="error-text">{row.error || 'не загрузился'}</small><small className="muted">{formatDate(row.at)}</small></span>
          <button className="ghost small" disabled={Boolean(action.busy)} onClick={() => void retry(row.id, '/api/content', { action: 'retryItem', itemId: row.id }, 'Загрузка материала повторяется.')}><Spin on={action.busy === row.id}><RotateCcw size={14} /></Spin>Повторить</button></li>)}
        {data.problems.versions.map(row => <li key={row.id}><span className="post-text"><strong>Вариант {row.slot + 1}: {row.title}</strong><small className="error-text">{row.error || 'не получился'}</small><small className="muted">{formatDate(row.at)}</small></span>
          <button className="ghost small" disabled={Boolean(action.busy)} onClick={() => void retry(row.id, '/api/content', { action: 'regenerateVariant', variantId: row.id }, 'Вариант будет написан заново.')}><Spin on={action.busy === row.id}><RotateCcw size={14} /></Spin>Написать заново</button></li>)}
      </ul> : <div className="panel-body"><p className="muted">Сбоев нет.</p></div>}
    </section>
    <section className="panel"><header className="panel-head"><h2>Копии базы</h2></header>
      {details?.backups?.length ? <ul className="plain-list">{details.backups.map(backup => <li key={backup.name}><span className="post-text"><strong>{backup.at ? formatDate(backup.at) : backup.name}</strong><small className="muted">перед миграциями: {backup.before.join(', ') || '—'}</small></span><span className={`pill ${backup.ok ? 'good' : 'bad'}`}>{backup.ok ? 'Проверена' : 'Не прошла проверку'}</span></li>)}</ul>
        : <div className="panel-body"><p className="muted">{details ? 'Копий пока нет. FERMA делает копию базы сама перед каждым обновлением со сменой структуры и хранит пять последних.' : 'Список копий присылает контент-движок, а он сейчас не на связи.'}</p></div>}
      <div className="panel-note"><small className="muted">Копии лежат в томе FERMA, в папке /data/backups. Восстановление: остановить FERMA и вернуть папку d1 из копии на место /data/v3/d1.</small></div>
    </section>
  </div>;
}
