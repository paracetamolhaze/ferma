"use client";
import { useEffect, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, ChevronRight, Plus } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import type { RecentMail } from '@/lib/mail';
import ProfileKeyForm from './profile-key-form';
import ProfileMail from './profile-mail';
import ProfileNameForm from './profile-name-form';
import ProfileSocialAccounts from './profile-social-accounts';
import { Avatar, CopyButton, Empty, formatTime, needsSetup, Network, Segmented, useZernio, type Ctx, type Profile } from './shared';
import { PostsPanel, QueueEditor } from './view-posts';
import { StatsPanel } from './view-stats';

export function ProfilesView({ ctx }: { ctx: Ctx }) {
  const { state } = ctx;
  const [filter, setFilter] = useState<'all' | 'setup'>('all');
  const [query, setQuery] = useState('');
  const incomplete = state.profiles.filter(profile => needsSetup(profile, state));
  const totals = useZernio<{ total: number }>(state.profiles.filter(profile => profile.configured), 'view=posts&limit=1');
  const search = query.trim().toLowerCase();
  const domain = state.mail?.domain;
  const rows = (filter === 'all' ? state.profiles : incomplete).filter(profile => {
    const names = state.channels.filter(channel => channel.profileId === profile.id).map(channel => channel.username).join(' ');
    return !search || `${profile.name} ${profile.emailLocal || ''} ${names}`.toLowerCase().includes(search);
  });
  if (!state.profiles.length) return <Empty title="Профилей пока нет" text="Создайте первый: название, ключ Zernio и адрес почты вводятся в одной форме." action={<button className="primary" onClick={ctx.addProfile}><Plus size={16} />Новый профиль</button>} />;
  return <div className="stack">
    <div className="toolbar">
      <Segmented label="Фильтр" value={filter} onChange={setFilter} options={[{ id: 'all', text: 'Все', count: state.profiles.length }, { id: 'setup', text: 'Нужна настройка', count: incomplete.length }]} />
      <input className="search" type="search" placeholder="Поиск профиля" aria-label="Поиск профиля" value={query} onChange={event => setQuery(event.target.value)} />
    </div>
    {rows.length ? <section className="panel"><div className="table-scroll"><table>
      <thead><tr><th>Профиль</th><th>Соцсети</th><th>Ключ Zernio</th><th>Почта</th><th className="num">Публикации</th><th /></tr></thead>
      <tbody>{rows.map(profile => {
        const channels = state.channels.filter(channel => channel.profileId === profile.id);
        const address = profile.emailLocal && domain ? `${profile.emailLocal}@${domain}` : '';
        const open = (tab = '') => ctx.go(`profile/${profile.id}${tab}`);
        return <tr key={profile.id} className="clickable" onClick={() => open()}>
          <td><span className="who"><Avatar profile={profile} /><strong>{profile.name}</strong></span></td>
          <td>{channels.length ? <span className="networks">{channels.map(channel => <Network key={channel.id} platform={channel.platform} username={channel.username} />)}</span>
            : <button className="link" onClick={event => { event.stopPropagation(); open('/settings'); }}>Подключить</button>}</td>
          <td>{profile.configured ? <span className="yes"><Check size={14} />Добавлен</span> : <button className="link" onClick={event => { event.stopPropagation(); open('/settings'); }}>Добавить ключ</button>}</td>
          <td>{address ? <span className="address-cell"><span>{address}</span><CopyButton value={address} /></span>
            : <button className="link" onClick={event => { event.stopPropagation(); if (domain) open(); else ctx.go('settings'); }}>Добавить адрес</button>}</td>
          <td className="num">{totals[profile.id]?.data?.total ?? '—'}</td>
          <td className="row-actions"><ChevronRight size={16} /></td>
        </tr>;
      })}</tbody>
    </table></div></section> : <Empty title="Ничего не найдено" text="Измените фильтр или поиск." />}
  </div>;
}

type Tab = 'overview' | 'posts' | 'queue' | 'stats' | 'settings';
const TABS: { id: Tab; text: string }[] = [{ id: 'overview', text: 'Почта и коды' }, { id: 'posts', text: 'Публикации' }, { id: 'queue', text: 'Автопубликация' }, { id: 'stats', text: 'Статистика' }, { id: 'settings', text: 'Подключения' }];

export function ProfilePage({ ctx, id, tab }: { ctx: Ctx; id: string; tab?: string }) {
  const { state } = ctx;
  const profile = state.profiles.find(item => item.id === id);
  const [revision, setRevision] = useState(0);
  if (!profile) return <Empty title="Профиль не найден" action={<button className="ghost" onClick={() => ctx.go('profiles')}>К списку профилей</button>} />;
  const current: Tab = TABS.some(item => item.id === tab) ? tab as Tab : 'overview';
  const channels = state.channels.filter(channel => channel.profileId === id);
  const steps = [
    { done: profile.configured, text: 'Добавьте ключ Zernio' },
    { done: channels.some(channel => channel.state === 'connected'), text: 'Подключите соцсеть в Zernio и обновите список' },
    { done: Boolean(state.mail && profile.emailLocal), text: 'Задайте адрес почты' },
  ];
  const open = (next: Tab) => ctx.go(`profile/${id}/${next}`);
  const needsKey = () => <div className="panel"><div className="panel-body"><p className="muted"><AlertCircle size={14} /> Нужен ключ Zernio. <button className="link" onClick={() => open('settings')}>Добавить</button></p></div></div>;
  return <div className="stack">
    <button className="link back" onClick={() => ctx.go('profiles')}><ArrowLeft size={14} />Все профили</button>
    <header className="profile-head">
      <Avatar profile={profile} size="large" />
      <div className="profile-title">
        <h1>{profile.name}</h1>
        <div className="profile-meta">
          {channels.map(channel => <Network key={channel.id} platform={channel.platform} username={channel.username} />)}
          {!channels.length && <span className="muted">Соцсети не подключены</span>}
        </div>
      </div>
      <button className="primary" onClick={() => ctx.compose(id)}><Plus size={16} />Новая публикация</button>
    </header>
    {steps.some(step => !step.done) && <div className="setup-steps">{steps.map(step =>
      <button key={step.text} className={step.done ? 'done' : ''} onClick={() => step.text.includes('почты') ? open('overview') : open('settings')}>{step.done ? <Check size={15} /> : <AlertCircle size={15} />}{step.text}</button>)}</div>}
    <nav className="tabs" aria-label="Разделы профиля">{TABS.map(item => <button key={item.id} aria-current={current === item.id ? 'page' : undefined} onClick={() => open(item.id)}>{item.text}</button>)}</nav>
    {current === 'overview' && <ProfileMail key={profile.id} profileId={id} emailLocal={profile.emailLocal} domain={state.mail?.domain || null} onSaved={ctx.reload} onOpenSettings={() => ctx.go('settings')} />}
    {current === 'posts' && <PostsPanel ctx={ctx} profiles={[profile]} />}
    {current === 'queue' && (profile.configured ? <QueueEditor profile={profile} ctx={ctx} /> : needsKey())}
    {current === 'stats' && (profile.configured ? <StatsPanel ctx={ctx} profiles={[profile]} /> : needsKey())}
    {current === 'settings' && <div className="columns">
      <section className="panel"><header className="panel-head"><h2>Ключ Zernio</h2></header><div className="panel-body">
        <ProfileKeyForm key={profile.id} profileId={id} name={profile.name} configured={profile.configured} canSave={state.canSaveKey} onSaved={async () => { await ctx.reload(); setRevision(value => value + 1); }} />
      </div></section>
      <div className="stack">
        <section className="panel"><div className="panel-body"><ProfileSocialAccounts key={profile.id} profileId={id} configured={profile.configured} revision={revision} channels={channels} onUpdated={ctx.reload} /></div></section>
        <section className="panel"><header className="panel-head"><h2>Название</h2></header><div className="panel-body"><ProfileNameForm key={`name-${id}`} profileId={id} name={profile.name} onSaved={ctx.reload} /></div></section>
      </div>
    </div>}
  </div>;
}

export function useRecentMail(enabled: boolean) {
  const [emails, setEmails] = useState<RecentMail[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    try {
      const data = await requestJson<{ emails: RecentMail[] }>('/api/mail?recent=1', { signal });
      if (signal?.aborted) return;
      setEmails(data.emails); setError('');
    } catch (failure) { if (!signal?.aborted) setError(failure instanceof Error ? failure.message : 'Не удалось загрузить письма.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    // Codes must appear on their own while a mail screen is open.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(controller.signal);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(controller.signal); }, 15000);
    return () => { clearInterval(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return { emails, error, loading, refresh };
}

export function MailRows({ ctx, emails, profiles, compact = false }: { ctx: Ctx; emails: RecentMail[]; profiles: Profile[]; compact?: boolean }) {
  return <div className="table-scroll"><table>
    <thead><tr><th>Код</th><th>Профиль</th>{!compact && <th>От кого</th>}<th>Тема</th><th className="num">Когда</th></tr></thead>
    <tbody>{emails.map(email => {
      const profile = profiles.find(item => item.id === email.profileId);
      return <tr key={email.id} className="clickable" onClick={() => ctx.go(`profile/${email.profileId}`)}>
        <td>{email.code ? <span className="code-chip"><code>{email.code}</code><CopyButton value={email.code} onCopied={() => ctx.notify('Код скопирован.')} /></span> : <span className="muted">—</span>}</td>
        <td className="nowrap">{profile?.name || '—'}</td>
        {!compact && <td className="cut">{email.from_address}</td>}
        <td className={compact ? 'cut narrow' : 'cut'}>{email.subject || 'Без темы'}</td>
        <td className="num nowrap">{formatTime(email.received_at)}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}
