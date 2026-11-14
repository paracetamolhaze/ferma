"use client";
/** FERMA's own posts in numbers, and recommendations the owner accepts or turns down. */
import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { ErrorLine, FORMAT_NAMES, Loading, send, Spin, useAction, useApi } from './content-ui';
import { Segmented, type Ctx } from './shared';

type Group = { name: string; posts: number; measured: number; views: number; medianViews: number | null; medianRate: number | null };
type Recommendation = { id: string; profileId: string | null; kind: string; title: string; reason: string; createdAt: string };
type Analytics = { days: number; total: Omit<Group, 'name'>; byPlatform: Group[]; byAccount: Group[]; byStyle: Group[]; byFormat: Group[]; byHour: Group[]; byCategory: Group[]; recommendations: Recommendation[] };
const percent = (value: number | null) => value === null ? '—' : `${(value * 100).toFixed(1).replace('.', ',')}%`;
const number = (value: number | null) => value === null ? '—' : Math.round(value).toLocaleString('ru-RU');

function GroupTable({ title, rows, label = name => name }: { title: string; rows: Group[]; label?: (name: string) => string }) {
  return <section className="panel"><header className="panel-head"><h2>{title}</h2></header><div className="table-scroll"><table>
    <thead><tr><th /><th className="num">Публикаций</th><th className="num">С данными</th><th className="num">Просмотры*</th><th className="num">Реакции*</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.name}><td className="nowrap">{label(row.name)}</td><td className="num">{row.posts}</td><td className="num">{row.measured}</td><td className="num">{number(row.medianViews)}</td><td className="num">{percent(row.medianRate)}</td></tr>)}</tbody>
  </table></div></section>;
}

export function FermaAnalytics({ ctx }: { ctx: Ctx }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const view = useApi<Analytics>(`/api/analytics?days=${days}`);
  const action = useAction(ctx);
  const data = view.data;
  const profileName = (id: string | null) => ctx.state.profiles.find(profile => profile.id === id)?.name || '';
  return <div className="stack">
    <div className="toolbar"><h2 className="toolbar-title">Публикации FERMA</h2><Segmented label="Период" value={days} onChange={setDays} options={[{ id: '7', text: '7 дней' }, { id: '30', text: '30 дней' }, { id: '90', text: '90 дней' }]} /></div>
    <ErrorLine text={view.error || action.error} />
    {view.loading && !data ? <Loading /> : data && <>
      {data.recommendations.length > 0 && <section className="panel"><header className="panel-head"><h2>Рекомендации</h2></header><ul className="plain-list">{data.recommendations.map(item => <li key={item.id}>
        <span className="post-text"><strong className="wrap">{profileName(item.profileId)}: {item.title}</strong><small className="muted wrap">{item.reason}</small></span>
        <span className="row-actions">
          <button className="primary small" disabled={Boolean(action.busy)} onClick={() => void action.run(item.id, async () => { await send('/api/analytics', { action: 'decide', id: item.id, accept: true }); await view.reload(); }, 'Изменение применено к профилю.')}><Spin on={action.busy === item.id}><Check size={14} /></Spin>Применить</button>
          <button className="ghost small" disabled={Boolean(action.busy)} onClick={() => void action.run(`no-${item.id}`, async () => { await send('/api/analytics', { action: 'decide', id: item.id, accept: false }); await view.reload(); })}><X size={14} />Не нужно</button>
        </span>
      </li>)}</ul></section>}
      {data.total.posts ? <><div className="tiles">
        <div className="tile"><span>Публикаций</span><strong>{data.total.posts}</strong><small>за {data.days} дн.</small></div>
        <div className="tile"><span>С данными соцсети</span><strong>{data.total.measured}</strong><small>{data.total.measured < data.total.posts ? `ещё без статистики: ${data.total.posts - data.total.measured}` : 'у всех публикаций'}</small></div>
        <div className="tile"><span>Просмотры</span><strong>{data.total.views.toLocaleString('ru-RU')}</strong><small>медиана {number(data.total.medianViews)}</small></div>
        <div className="tile"><span>Реакции к просмотрам</span><strong>{percent(data.total.medianRate)}</strong><small>медиана по постам</small></div>
      </div>
        <GroupTable title="Аккаунт" rows={data.byAccount} />
        <div className="columns"><GroupTable title="Подача варианта" rows={data.byStyle} /><GroupTable title="Формат" rows={data.byFormat} label={name => FORMAT_NAMES[name] || name} /></div>
        <div className="columns"><GroupTable title="Время, по часам профиля" rows={data.byHour} /><GroupTable title="Тема" rows={data.byCategory} /></div>
      <p className="muted small-note">* Медиана по публикациям: просмотры и доля реакций от просмотров. Только числа, которые вернули Threads и Instagram; пост без статистики не считается нулём. Статистика обновляется раз в 30 минут. Рекомендация появляется, когда разница не меньше 30% и с каждой стороны не меньше 5 постов; без вашего «Применить» ничего не меняется.</p>
      </> : <p className="muted">За {data.days} дн. публикаций FERMA нет. Просмотры и реакции появятся здесь после первых публикаций через свои приложения Meta.</p>}
    </>}
  </div>;
}
