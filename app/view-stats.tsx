"use client";
import { useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { ProfileStats } from '@/lib/zernio-insights';
import { Avatar, Empty, formatDate, formatNumber, networkName, Segmented, useZernio, type Ctx, type Profile } from './shared';

type Metric = 'views' | 'reach' | 'engagement';
const METRICS: { id: Metric; text: string }[] = [{ id: 'views', text: 'Просмотры' }, { id: 'reach', text: 'Охват' }, { id: 'engagement', text: 'Реакции' }];
const reactions = (m: { likes: number; comments: number; shares: number; saves: number }) => m.likes + m.comments + m.shares + m.saves;
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

function DailyChart({ data, metric }: { data: { date: string; value: number }[]; metric: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map(item => item.value), 1);
  const point = hover === null ? null : data[hover];
  return <figure className="chart" aria-label={`${metric} по дням`}>
    <div className="chart-plot" onMouseLeave={() => setHover(null)}>
      <span className="chart-max">{formatNumber(max)}</span>
      <div className="chart-bars">{data.map((item, index) =>
        <div key={item.date} className={`chart-slot ${hover === index ? 'on' : ''}`} onMouseEnter={() => setHover(index)}>
          <i style={{ height: `${Math.max(item.value ? 3 : 0, (item.value / max) * 100)}%` }} />
        </div>)}</div>
      {point && hover !== null && <div className="chart-tip" style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}><small>{dayLabel(point.date)}</small><strong>{formatNumber(point.value)}</strong><small>{metric}</small></div>}
    </div>
    <figcaption><span>{dayLabel(data[0].date)}</span><span>{dayLabel(data[data.length - 1].date)}</span></figcaption>
  </figure>;
}
const delta = (now: number, before?: number) => {
  if (before === undefined || before === 0) return null;
  const change = Math.round(((now - before) / before) * 100);
  return `${change > 0 ? '+' : ''}${change}% к прошлому периоду`;
};

export function StatsPanel({ ctx, profiles }: { ctx: Ctx; profiles: Profile[] }) {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [metric, setMetric] = useState<Metric>('views');
  const results = useZernio<ProfileStats>(profiles, `view=stats&days=${days}`);
  const single = profiles.length === 1;
  const loaded = profiles.flatMap(profile => results[profile.id]?.data ? [{ profile, stats: results[profile.id].data! }] : []);
  const loading = profiles.some(profile => results[profile.id]?.loading);
  const errors = profiles.flatMap(profile => results[profile.id]?.error ? [{ profile, error: results[profile.id].error! }] : []);
  const sum = useMemo(() => {
    const add = (read: (stats: ProfileStats) => number) => loaded.reduce((total, item) => total + read(item.stats), 0);
    const addPrevious = (read: (stats: NonNullable<ProfileStats['previousTotals']>) => number) => loaded.every(item => item.stats.previousTotals) ? loaded.reduce((total, item) => total + read(item.stats.previousTotals!), 0) : undefined;
    return {
      followers: add(s => s.followers.current), gained: add(s => s.followers.gained), views: add(s => s.totals.views), reach: add(s => s.totals.reach),
      reactions: add(s => reactions(s.totals)), impressions: add(s => s.totals.impressions),
      previousViews: addPrevious(s => s.views), previousReach: addPrevious(s => s.reach), previousReactions: addPrevious(reactions),
    };
    // `loaded` is rebuilt from `results` on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);
  const daily = useMemo(() => {
    const byDate = new Map<string, number>();
    for (const { stats } of loaded) for (const day of stats.daily) byDate.set(day.date, (byDate.get(day.date) || 0) + day[metric]);
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, metric]);
  const top = loaded.flatMap(({ profile, stats }) => stats.topPosts.map(post => ({ ...post, profile }))).sort((a, b) => reactions(b.metrics) + b.metrics.views - reactions(a.metrics) - a.metrics.views).slice(0, 10);
  const rate = sum.impressions ? `${((sum.reactions / sum.impressions) * 100).toFixed(1).replace('.', ',')}%` : '—';
  const asOf = loaded.map(item => item.stats.dataAsOf).filter(Boolean).sort().at(-1);
  const hasData = daily.some(item => item.value > 0);
  if (!profiles.length) return <Empty title="Нет профилей с ключом Zernio" text="Статистика появится, когда профилю будет добавлен ключ." action={<button className="primary" onClick={() => ctx.go('profiles')}>К профилям</button>} />;
  const tiles = [
    { label: 'Подписчики', value: formatNumber(sum.followers), note: `${sum.gained > 0 ? '+' : ''}${formatNumber(sum.gained)} за период` },
    { label: 'Просмотры', value: formatNumber(sum.views), note: delta(sum.views, sum.previousViews) },
    { label: 'Охват', value: formatNumber(sum.reach), note: delta(sum.reach, sum.previousReach) },
    { label: 'Реакции', value: formatNumber(sum.reactions), note: delta(sum.reactions, sum.previousReactions) },
    { label: 'Вовлечённость', value: rate, note: 'реакции к показам' },
  ];
  return <div className="stack">
    <div className="toolbar">
      <Segmented label="Период" value={days} onChange={setDays} options={[{ id: '7', text: '7 дней' }, { id: '30', text: '30 дней' }, { id: '90', text: '90 дней' }]} />
      <span className="toolbar-note">{loading ? <><Loader2 size={14} className="spin" />Загружаем из Zernio…</> : asOf ? `Данные Zernio на ${formatDate(asOf)}` : ''}</span>
    </div>
    {errors.map(item => <p className="notice-bad" key={item.profile.id} role="alert">{single ? '' : `${item.profile.name}: `}{item.error}</p>)}
    <div className="tiles">{tiles.map(tile => <div className="tile" key={tile.label}><span>{tile.label}</span><strong>{tile.value}</strong>{tile.note && <small>{tile.note}</small>}</div>)}</div>
    <section className="panel">
      <header className="panel-head"><h2>По дням</h2><Segmented label="Показатель" value={metric} onChange={setMetric} options={METRICS} /></header>
      <div className="panel-body">
        {hasData ? <DailyChart data={daily} metric={METRICS.find(item => item.id === metric)!.text} /> : !loading && <p className="muted">Zernio пока не вернул показатели за этот период.</p>}
      </div>
    </section>
    {!single && <section className="panel">
      <header className="panel-head"><h2>По профилям</h2></header>
      <div className="table-scroll"><table>
        <thead><tr><th>Профиль</th><th className="num">Подписчики</th><th className="num">Прирост</th><th className="num">Просмотры</th><th className="num">Охват</th><th className="num">Реакции</th></tr></thead>
        <tbody>{profiles.map(profile => {
          const entry = results[profile.id], s = entry?.data;
          return <tr key={profile.id} className="clickable" onClick={() => ctx.go(`profile/${profile.id}/stats`)}>
            <td><span className="who"><Avatar profile={profile} />{profile.name}</span></td>
            {s ? <><td className="num">{formatNumber(s.followers.current)}</td><td className="num">{s.followers.gained > 0 ? '+' : ''}{formatNumber(s.followers.gained)}</td><td className="num">{formatNumber(s.totals.views)}</td><td className="num">{formatNumber(s.totals.reach)}</td><td className="num">{formatNumber(reactions(s.totals))}</td></>
              : <td colSpan={5} className="muted">{entry?.loading ? 'Загружаем…' : entry?.error || 'Нет данных'}</td>}
          </tr>;
        })}</tbody>
      </table></div>
    </section>}
    {top.length > 0 && <section className="panel">
      <header className="panel-head"><h2>Лучшие публикации за период</h2></header>
      <div className="table-scroll"><table>
        <thead><tr><th>Дата</th><th>Соцсеть</th>{!single && <th>Профиль</th>}<th className="num">Просмотры</th><th className="num">Охват</th><th className="num">Реакции</th></tr></thead>
        <tbody>{top.map(post => <tr key={`${post.profile.id}-${post.postId}-${post.platform}`}>
          <td>{post.publishedAt ? formatDate(post.publishedAt) : '—'}</td><td>{networkName(post.platform || '')}</td>{!single && <td>{post.profile.name}</td>}
          <td className="num">{formatNumber(post.metrics.views)}</td><td className="num">{formatNumber(post.metrics.reach)}</td><td className="num">{formatNumber(reactions(post.metrics))}</td>
        </tr>)}</tbody>
      </table></div>
    </section>}
    <p className="muted small-note">Показатели считает Zernio по текущим подключённым соцсетям.</p>
  </div>;
}
