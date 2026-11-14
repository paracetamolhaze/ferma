"use client";
import { useEffect, useRef, useState } from 'react';
import { Activity as ActivityIcon, AlertCircle, AtSign, BarChart3, CalendarDays, Check, FolderOpen, Inbox, Layers, LayoutDashboard, ListOrdered, Loader2, Mail, Megaphone, MessageCircle, Plus, RefreshCw, Settings2, UploadCloud, Users, Video, X } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import { MAX_UPLOAD, missingNetworks, NETWORKS, validateTargets } from '@/lib/domain';
import type { ProfileQueue, RemotePost } from '@/lib/zernio-insights';
import AddProfile from './add-profile';
import MailSettingsForm from './mail-settings-form';
import { Avatar, connectedNetworks, Empty, formatDate, initialState, Modal, needsSetup, Network, networkName, problemStatuses, useZernio, type Ctx, type Media, type Post, type State } from './shared';
import { BulkModal } from './view-posts';
import { CodeRows, ProfilePage, ProfilesView, useRecentCodes } from './view-profiles';
import { SmsSettings, UnmatchedSms } from './sms-panels';
import { FivesimSettings } from './access-panels';
import { StatsPanel } from './view-stats';
import { useApi } from './content-ui';
import { ContentSettings } from './content-settings';
import { AccountsView } from './view-accounts';
import { ActivityView } from './view-activity';
import { FermaAnalytics } from './view-analytics';
import { CampaignsView } from './view-campaigns';
import { PublicationsView } from './view-queue';
import { SourcesView } from './view-sources';
import { SystemView } from './view-system';
import { VariantsView } from './view-variants';

const NAV = [
  { id: 'overview', icon: LayoutDashboard, text: 'Обзор' },
  { id: 'profiles', icon: Users, text: 'Профили' },
  { id: 'sources', icon: Inbox, text: 'Источники' },
  { id: 'variants', icon: Layers, text: 'Варианты' },
  { id: 'campaigns', icon: Megaphone, text: 'Кампании' },
  { id: 'posts', icon: CalendarDays, text: 'Публикации' },
  { id: 'accounts', icon: AtSign, text: 'Аккаунты' },
  { id: 'activity', icon: MessageCircle, text: 'Активность' },
  { id: 'stats', icon: BarChart3, text: 'Статистика' },
  { id: 'mail', icon: Mail, text: 'Почта, СМС и коды' },
  { id: 'library', icon: FolderOpen, text: 'Медиатека' },
];
const TITLES: Record<string, string> = { overview: 'Обзор', profiles: 'Профили', sources: 'Источники', variants: 'Варианты', campaigns: 'Кампании', accounts: 'Аккаунты', activity: 'Активность', mail: 'Почта, СМС и коды', posts: 'Публикации', stats: 'Статистика', library: 'Медиатека', system: 'Состояние системы', settings: 'Настройки' };
type OverviewQueue = { rows: { source: string; id: string; profileId: string; platform: string; account: string | null; status: string; at: string; title: string; text: string }[] };
type OverviewSystem = { counts: { publications: Record<string, number> }; problems: Record<string, unknown[]> };
const sizeText = (size: number) => size < 1024 ? `${size} Б` : size < 1048576 ? `${(size / 1024).toFixed(1)} КБ` : `${(size / 1048576).toFixed(1)} МБ`;

function Overview({ ctx }: { ctx: Ctx }) {
  const { state } = ctx;
  const withKey = state.profiles.filter(profile => profile.configured);
  const scheduled = useZernio<{ posts: RemotePost[]; total: number }>(withKey, 'view=posts&status=scheduled');
  const failed = useZernio<{ posts: RemotePost[]; total: number }>(withKey, 'view=posts&status=failed');
  const codes = useRecentCodes(state);
  const queue = useApi<OverviewQueue>('/api/publications', 60000);
  const system = useApi<OverviewSystem>('/api/system', 60000);
  const activity = useApi<{ waiting: number }>('/api/activity', 60000);
  // FERMA's own scheduled posts and the Zernio ones, by time.
  const zernioUpcoming = Object.entries(scheduled).flatMap(([id, item]) => (item.data?.posts || []).map(post => ({ key: `z:${post.id}`, profileId: id, title: post.title || post.content || (post.media === 'video' ? 'Видео без подписи' : post.media ? 'Фото без подписи' : 'Без текста'), platforms: post.platforms.map(entry => entry.platform), at: post.at, via: 'Zernio' })));
  const fermaUpcoming = (queue.data?.rows || []).filter(row => row.source === 'ferma' && ['scheduled', 'awaiting_approval'].includes(row.status)).map(row => ({ key: `f:${row.id}`, profileId: row.profileId, title: row.title || row.text.slice(0, 80) || 'Публикация', platforms: [row.platform], at: row.at, via: row.status === 'awaiting_approval' ? 'FERMA, ждёт одобрения' : 'FERMA' }));
  const upcoming = [...zernioUpcoming, ...fermaUpcoming].filter(post => post.at).sort((a, b) => (a.at || '').localeCompare(b.at || ''));
  const loadingScheduled = Object.values(scheduled).some(item => item.loading) || queue.loading && !queue.data;
  const remoteProblems = Object.values(failed).reduce((total, item) => total + (item.data?.total || 0), 0);
  const localProblems = state.posts.filter(post => problemStatuses.includes(post.status) && !post.zernioId).length;
  const fermaCounts = system.data?.counts.publications || {};
  const systemProblems = system.data ? Object.values(system.data.problems).reduce((total, list) => total + list.length, 0) : null;
  const setup = state.profiles.filter(profile => needsSetup(profile, state));
  const tiles = [
    { label: 'Профили', value: state.profiles.length, note: setup.length ? `настроить: ${setup.length}` : 'все настроены', go: 'profiles' },
    { label: 'Ждут одобрения', value: system.data ? fermaCounts.awaiting_approval || 0 : '…', note: 'публикации FERMA', go: 'posts' },
    { label: 'Запланировано', value: loadingScheduled ? '…' : upcoming.length, note: `FERMA: ${fermaUpcoming.length}, Zernio: ${zernioUpcoming.length}`, go: 'posts' },
    { label: 'Ошибки публикаций', value: remoteProblems + localProblems + (fermaCounts.failed || 0), note: `FERMA: ${fermaCounts.failed || 0}, Zernio: ${remoteProblems + localProblems}`, go: 'posts' },
    { label: 'Комментарии', value: activity.data ? activity.data.waiting : '…', note: 'ждут ответа', go: 'activity' },
    { label: 'Система', value: systemProblems === null ? '…' : systemProblems ? `сбоев: ${systemProblems}` : 'в порядке', note: 'процессы и очереди', go: 'system' },
  ];
  if (!state.profiles.length) return <Empty title="Начните с первого профиля" text="Название, ключ Zernio и адрес почты вводятся в одной форме." action={<button className="primary" onClick={ctx.addProfile}><Plus size={16} />Новый профиль</button>} />;
  return <div className="stack">
    <div className="tiles">{tiles.map(tile => <button className="tile" key={tile.label} onClick={() => ctx.go(tile.go)}><span>{tile.label}</span><strong>{tile.value}</strong><small>{tile.note}</small></button>)}</div>
    <div className="columns">
      <section className="panel">
        <header className="panel-head"><h2>Свежие коды</h2><button className="link" onClick={() => ctx.go('mail')}>Все письма и СМС</button></header>
        {!state.mail && !state.sms ? <div className="panel-body"><p className="muted">Почта и СМС не подключены. <button className="link" onClick={() => ctx.go('settings')}>Подключить</button></p></div>
          : codes.error ? <div className="panel-body"><p className="error-text" role="alert">{codes.error}</p></div>
          : codes.rows.length ? <CodeRows ctx={ctx} rows={codes.rows.slice(0, 6)} profiles={state.profiles} compact />
          : <div className="panel-body"><p className="muted">{codes.ready ? 'Сообщений пока нет.' : 'Загружаем…'}</p></div>}
      </section>
      <section className="panel">
        <header className="panel-head"><h2>Ближайшие публикации</h2><button className="link" onClick={() => ctx.go('posts')}>Все</button></header>
        {upcoming.length ? <ul className="plain-list">{upcoming.slice(0, 6).map(post => {
          const profile = state.profiles.find(item => item.id === post.profileId);
          return <li key={post.key}>
            <span className="post-text"><strong>{post.title}</strong><small>{[profile?.name, post.via].filter(Boolean).join(' · ')}</small></span>
            <span className="networks">{post.platforms.map(platform => <Network key={platform} platform={platform} />)}</span>
            <time>{post.at ? formatDate(post.at) : '—'}</time>
          </li>;
        })}</ul> : <div className="panel-body"><p className="muted">{loadingScheduled ? 'Загружаем…' : 'Ничего не запланировано.'}</p></div>}
      </section>
    </div>
    {setup.length > 0 && <section className="panel">
      <header className="panel-head"><h2>Нужно настроить</h2></header>
      <ul className="plain-list">{setup.map(profile => {
        const missing = [!profile.configured && 'ключ Zernio', ...missingNetworks(connectedNetworks(profile.id, state)).map(networkName), state.mail && !profile.emailLocal && 'адрес почты'].filter(Boolean).join(', ');
        return <li key={profile.id} className="clickable" onClick={() => ctx.go(`profile/${profile.id}/settings`)}><span className="who"><Avatar profile={profile} /><strong>{profile.name}</strong></span><span className="muted">нет: {missing}</span></li>;
      })}</ul>
    </section>}
  </div>;
}

function MailView({ ctx }: { ctx: Ctx }) {
  const { state } = ctx;
  const { rows: all, ready, error, loading, refresh, smsMessages } = useRecentCodes(state);
  const [onlyCodes, setOnlyCodes] = useState(false);
  if (!state.mail && !state.sms) return <Empty title="Почта и СМС не подключены" text="Подключите их в настройках." action={<button className="primary" onClick={() => ctx.go('settings')}>Открыть настройки</button>} />;
  const rows = all.filter(row => !onlyCodes || row.code);
  const withoutAddress = state.profiles.filter(profile => !profile.emailLocal);
  return <div className="stack">
    <div className="toolbar">
      <label className="switch"><input type="checkbox" checked={onlyCodes} onChange={event => setOnlyCodes(event.target.checked)} />Только с кодом</label>
      <span className="toolbar-note">Обновляется само каждые 15 секунд</span>
      <button className="ghost" disabled={loading} onClick={refresh}>{loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Обновить</button>
    </div>
    {error && <p className="notice-bad" role="alert">{error}</p>}
    <UnmatchedSms ctx={ctx} messages={smsMessages} onBound={refresh} />
    {rows.length ? <section className="panel"><CodeRows ctx={ctx} rows={rows} profiles={state.profiles} /></section> : !error && <Empty title={ready ? 'Сообщений пока нет' : 'Загружаем…'} text={ready ? 'Новые письма и СМС профилей появятся здесь.' : undefined} />}
    {withoutAddress.length > 0 && <p className="muted">Нет адреса: {withoutAddress.map(profile => <button className="link spaced" key={profile.id} onClick={() => ctx.go(`profile/${profile.id}`)}>{profile.name}</button>)}</p>}
  </div>;
}

function Library({ ctx, upload, uploadActive, pick, onPreview }: { ctx: Ctx; upload: (files: FileList) => void; uploadActive: boolean; pick: () => void; onPreview: (item: Media) => void }) {
  const [query, setQuery] = useState('');
  const [over, setOver] = useState(false);
  const items = ctx.state.media.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="stack">
    <div className={`dropzone ${over ? 'over' : ''}`} onDragOver={event => { event.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={event => { event.preventDefault(); setOver(false); upload(event.dataTransfer.files); }}>
      <UploadCloud size={22} /><span>Перетащите файлы сюда или <button className="link" disabled={uploadActive} onClick={pick}>выберите на компьютере</button></span><small>MP4, MOV, JPG, PNG, WebP до 90 МБ</small>
    </div>
    <input className="search" type="search" placeholder="Поиск файла" aria-label="Поиск файла" value={query} onChange={event => setQuery(event.target.value)} />
    {items.length ? <div className="media-grid">{items.map(item => <article className="media-card" key={item.id}>
      <button className="media-preview" onClick={() => onPreview(item)} aria-label={`Просмотр ${item.name}`}>{item.type.startsWith('image') ? <img loading="lazy" src={`/api/media?id=${item.id}`} alt={item.name} /> : <Video size={30} />}</button>
      <div className="media-info"><strong title={item.name}>{item.name}</strong><small>{sizeText(item.size)} · {formatDate(item.createdAt)}</small><button className="ghost small" onClick={() => ctx.compose(undefined, item.id)}><Plus size={14} />В публикацию</button></div>
    </article>)}</div> : <Empty title={ctx.state.media.length ? 'Файлы не найдены' : 'Медиатека пустая'} text={ctx.state.media.length ? undefined : 'Загруженные файлы можно использовать в публикациях.'} />}
  </div>;
}

function Settings({ ctx }: { ctx: Ctx }) {
  const { state } = ctx;
  return <div className="columns">
    <ContentSettings ctx={ctx} />
    <section className="panel">
      <header className="panel-head"><h2>Почта (MailClaw)</h2><span className={`pill ${state.mail ? 'good' : 'plain'}`}>{state.mail ? 'Подключена' : 'Не подключена'}</span></header>
      <div className="panel-body"><MailSettingsForm key={state.mail ? `${state.mail.baseUrl} ${state.mail.domain}` : 'new'} mail={state.mail} canSave={state.canSaveKey} onSaved={ctx.reload} /></div>
    </section>
    <SmsSettings ctx={ctx} />
    <FivesimSettings ctx={ctx} />
    <section className="panel">
      <header className="panel-head"><h2>Ключи Zernio</h2><a className="link" href="https://zernio.com" target="_blank" rel="noreferrer">Кабинет Zernio</a></header>
      {state.profiles.length ? <ul className="plain-list">{state.profiles.map(profile => <li key={profile.id} className="clickable" onClick={() => ctx.go(`profile/${profile.id}/settings`)}>
        <span className="who"><Avatar profile={profile} /><strong>{profile.name}</strong></span>
        {profile.configured ? <span className="yes"><Check size={14} />Добавлен</span> : <span className="link">Добавить ключ</span>}
      </li>)}</ul> : <div className="panel-body"><button className="primary" onClick={ctx.addProfile}><Plus size={16} />Новый профиль</button></div>}
    </section>
  </div>;
}

export default function Home() {
  const [state, setState] = useState<State>(initialState);
  const [route, setRoute] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState<{ profileId?: string } | null>(null);
  const [editor, setEditor] = useState<Partial<Post> | null>(null);
  const [schedule, setSchedule] = useState<Post | null>(null);
  const [scheduleMode, setScheduleMode] = useState<'time' | 'queue'>('time');
  const [queue, setQueue] = useState<ProfileQueue | null>(null);
  const [minimumDate, setMinimumDate] = useState('');
  const [deleting, setDeleting] = useState<Post | null>(null);
  const [preview, setPreview] = useState<Media | null>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadActive, setUploadActive] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function reload() {
    const data = await requestJson<State>('/api/workspace');
    setState(data);
    setSchedule(current => current ? data.posts.find(post => post.id === current.id) || null : null);
    setLoading(false);
    return data;
  }
  const post = (body: Record<string, unknown>) => requestJson<{ id?: string }>('/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function run(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); }
    catch (failure) {
      // Provider failures may persist an uncertain status; show the stored result.
      await reload().catch(() => undefined);
      setError(failure instanceof Error ? failure.message : 'Что-то пошло не так.');
    } finally { setBusy(false); }
  }
  useEffect(() => {
    // Initial network load: reload updates state only after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload().catch(failure => { setLoading(false); setError(failure.message); });
    const sync = () => setRoute(location.hash.slice(1) || 'overview');
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  function go(next: string) {
    setError('');
    location.hash = next;
    window.scrollTo({ top: 0 });
  }
  function compose(profileId?: string, mediaId?: string) {
    setError('');
    if (!state.profiles.length) { setAdding(true); return; }
    const target = profileId || state.profiles[0].id;
    // A profile is run on all its networks at once; unticking stays possible for a single post.
    setEditor({ profileId: target, mediaId: mediaId || null, title: '', content: '', platforms: JSON.stringify(connectedNetworks(target, state)) });
  }
  function plan(item: Post) {
    setError('');
    // Called only by click handlers; the lower bound is captured when the form opens.
    // eslint-disable-next-line react-hooks/purity
    setMinimumDate(new Date(Date.now() + 5 * 3600000 + 120000).toISOString().slice(0, 16));
    setScheduleMode('time'); setQueue(null); setSchedule(item);
    requestJson<ProfileQueue>(`/api/zernio?profileId=${item.profileId}&view=queue`).then(setQueue).catch(() => setQueue(null));
  }
  async function uploadFiles(files: FileList) {
    if (uploadActive) return;
    setError(''); setUploadActive(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size > MAX_UPLOAD || !['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error(`${file.name}: нужен MP4, MOV, JPG, PNG или WebP до 90 МБ.`);
        setUploading(0); setUploadName(file.name);
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/media');
          xhr.timeout = 180000;
          xhr.setRequestHeader('Content-Type', file.type);
          xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
          xhr.upload.onprogress = event => { if (event.lengthComputable) setUploading(Math.round((event.loaded / event.total) * 100)); };
          xhr.onerror = () => reject(new Error('Связь прервалась. Повторите загрузку.'));
          xhr.ontimeout = () => reject(new Error('Загрузка заняла слишком много времени. Повторите попытку.'));
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              let uploaded: { id: string };
              try { uploaded = JSON.parse(xhr.responseText); if (!uploaded.id) throw new Error('missing id'); }
              catch { reject(new Error('Сервер не подтвердил сохранение файла. Обновите медиатеку.')); return; }
              setEditor(current => current ? { ...current, mediaId: uploaded.id } : null);
              resolve();
            } else {
              try { reject(new Error(JSON.parse(xhr.responseText).error)); }
              catch { reject(new Error('Не удалось загрузить файл.')); }
            }
          };
          xhr.send(file);
        });
        await reload();
      }
      setNotice('Файлы добавлены в медиатеку.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка загрузки.'); }
    finally { setUploadActive(false); if (fileRef.current) fileRef.current.value = ''; }
  }
  const ctx: Ctx = {
    state, busy, reload, go, compose,
    edit: item => { setError(''); setEditor(item); },
    plan, remove: setDeleting, addProfile: () => { setError(''); setAdding(true); }, notify: setNotice,
    bulk: profileId => { setError(''); if (state.profiles.length) setBulk({ profileId }); else setAdding(true); },
  };
  const [section, routeId, routeTab] = route.split('/');
  const onProfile = section === 'profile';
  const activeNav = onProfile ? 'profiles' : section;
  const withKey = state.profiles.filter(profile => profile.configured);
  const headerAction = section === 'profiles' ? <button className="primary" onClick={ctx.addProfile}><Plus size={16} />Новый профиль</button>
    : section === 'library' ? <button className="primary" disabled={uploadActive} onClick={() => fileRef.current?.click()}><UploadCloud size={16} />Загрузить файлы</button>
    : section === 'overview' ? <button className="ghost" disabled={busy || !withKey.length} onClick={() => run(async () => { await post({ action: 'sync' }); await reload(); setNotice('Соцсети и статусы обновлены.'); })}>{busy ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Обновить из Zernio</button> : null;
  let scheduleIssue = '';
  if (schedule?.status === 'draft') {
    const selected = state.media.find(item => item.id === schedule.mediaId);
    const targets: string[] = JSON.parse(schedule.platforms);
    try {
      validateTargets(targets, schedule.content, selected?.type.startsWith('video/') ? 'video' : selected ? 'image' : undefined);
      if (targets.some(platform => !state.channels.some(channel => channel.state === 'connected' && channel.profileId === schedule.profileId && channel.platform === platform))) throw new Error('Обновите соцсети в профиле и выберите подключённые аккаунты.');
      if (!schedule.content.trim() && !selected) throw new Error('Добавьте подпись или файл.');
    } catch (failure) { scheduleIssue = failure instanceof Error ? failure.message : 'Проверьте черновик.'; }
  }
  const scheduleConfigured = Boolean(state.profiles.find(profile => profile.id === schedule?.profileId)?.configured);
  const queueReady = Boolean(queue?.exists && queue.active && queue.nextSlots.length);
  return <div className="app">
    <aside className="rail">
      <button className="brand" onClick={() => go('overview')}>ferma</button>
      <nav aria-label="Основная навигация">{NAV.map(item => <button key={item.id} aria-current={activeNav === item.id ? 'page' : undefined} onClick={() => go(item.id)}><item.icon size={17} />{item.text}</button>)}</nav>
      <div className="rail-foot">
        <button className="rail-add" onClick={ctx.addProfile}><Plus size={16} />Новый профиль</button>
        <nav aria-label="Настройки"><button aria-current={section === 'system' ? 'page' : undefined} onClick={() => go('system')}><ActivityIcon size={17} />Состояние системы</button><button aria-current={section === 'settings' ? 'page' : undefined} onClick={() => go('settings')}><Settings2 size={17} />Настройки</button></nav>
      </div>
    </aside>
    <main id="main">
      {!onProfile && <header className="page-head"><h1>{TITLES[section] || 'Обзор'}</h1>{headerAction}</header>}
      {error && !adding && !editor && !schedule && !deleting && <div className="notice-bad" role="alert"><AlertCircle size={16} /><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="Закрыть ошибку"><X size={15} /></button></div>}
      {notice && <div className="toast" role="status"><Check size={15} />{notice}<button aria-label="Закрыть" onClick={() => setNotice('')}><X size={14} /></button></div>}
      <input hidden ref={fileRef} type="file" multiple accept="video/mp4,video/quicktime,image/jpeg,image/png,image/webp" onChange={event => { if (event.target.files) void uploadFiles(event.target.files); }} />
      {uploadActive && <div className="upload-progress" role="status"><Loader2 className="spin" size={16} /><span>{uploadName}</span><progress value={uploading} max={100} /><span>{uploading}%</span></div>}
      {loading ? <p className="muted"><Loader2 className="spin" size={16} /> Загружаем…</p> : <>
        {section === 'overview' && <Overview ctx={ctx} />}
        {section === 'profiles' && <ProfilesView ctx={ctx} />}
        {onProfile && <ProfilePage key={routeId} ctx={ctx} id={routeId} tab={routeTab} />}
        {section === 'mail' && <MailView ctx={ctx} />}
        {section === 'sources' && <SourcesView ctx={ctx} />}
        {section === 'variants' && <VariantsView key={routeId || 'all'} ctx={ctx} itemId={routeId} />}
        {section === 'campaigns' && <CampaignsView ctx={ctx} />}
        {section === 'accounts' && <AccountsView ctx={ctx} />}
        {section === 'activity' && <ActivityView ctx={ctx} />}
        {section === 'posts' && <PublicationsView ctx={ctx} />}
        {section === 'stats' && <div className="stack"><FermaAnalytics ctx={ctx} /><h2 className="section-heading">Zernio</h2><StatsPanel ctx={ctx} profiles={withKey} /></div>}
        {section === 'system' && <SystemView ctx={ctx} />}
        {section === 'library' && <Library ctx={ctx} upload={files => void uploadFiles(files)} uploadActive={uploadActive} pick={() => fileRef.current?.click()} onPreview={setPreview} />}
        {section === 'settings' && <Settings ctx={ctx} />}
      </>}
    </main>
    {adding && <AddProfile ctx={ctx} close={() => setAdding(false)} />}
    {bulk && <BulkModal ctx={ctx} initialProfile={bulk.profileId} close={() => setBulk(null)} />}
    {editor && <Modal title={editor.id ? 'Редактировать черновик' : 'Новая публикация'} close={() => !busy && !uploadActive && setEditor(null)} wide>
      <form onSubmit={event => {
        event.preventDefault();
        const next = ((event.nativeEvent as SubmitEvent).submitter as HTMLElement | null)?.dataset.next;
        void run(async () => {
          const saved = await post({ id: editor.id, profileId: editor.profileId, title: editor.title, content: editor.content, mediaId: editor.mediaId, action: 'draft', platforms: JSON.parse(editor.platforms || '[]') });
          const latest = await reload();
          setEditor(null);
          const draft = latest.posts.find(item => item.id === saved.id);
          if (next === 'plan' && draft) plan(draft);
          else setNotice('Черновик сохранён. Запланируйте его в разделе «Публикации».');
        });
      }}>
        <div className="form-body form-columns">
          <div className="form-stack">
            <label>Профиль<select value={editor.profileId} onChange={event => setEditor({ ...editor, profileId: event.target.value, platforms: JSON.stringify(connectedNetworks(event.target.value, state)) })}>{state.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
            <label>Название<input required maxLength={100} value={editor.title} onChange={event => setEditor({ ...editor, title: event.target.value })} placeholder="Название публикации или видео" /></label>
            <label>Подпись<textarea rows={6} maxLength={5000} value={editor.content} onChange={event => setEditor({ ...editor, content: event.target.value })} placeholder="Текст публикации" /></label>
            <small className="muted">{editor.content?.length || 0} символов</small>
          </div>
          <div className="form-stack">
            <label>Файл<select value={editor.mediaId || ''} onChange={event => setEditor({ ...editor, mediaId: event.target.value || null })}><option value="">Без файла</option>{state.media.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <button type="button" className="ghost" onClick={() => fileRef.current?.click()} disabled={uploadActive}><UploadCloud size={16} />{uploadActive ? `Загрузка ${uploading}%` : 'Загрузить новый файл'}</button>
            <fieldset><legend>Куда опубликовать</legend><div className="targets">{NETWORKS.map(network => {
              const chosen: string[] = JSON.parse(editor.platforms || '[]');
              const checked = chosen.includes(network.id);
              const available = state.channels.some(channel => channel.profileId === editor.profileId && channel.platform === network.id && channel.state === 'connected');
              return <label key={network.id} className={available ? '' : 'off'}><input type="checkbox" checked={checked} disabled={!available} onChange={() => setEditor({ ...editor, platforms: JSON.stringify(checked ? chosen.filter(item => item !== network.id) : [...chosen, network.id]) })} /><Network platform={network.id} /><span>{network.name}</span>{!available && <small>не подключено</small>}</label>;
            })}</div></fieldset>
          </div>
        </div>
        {error && <p className="error-text form-error" role="alert">{error}</p>}
        <div className="modal-footer"><button type="button" className="ghost" disabled={busy || uploadActive} onClick={() => setEditor(null)}>Отмена</button><button className="ghost" disabled={busy || uploadActive}>Сохранить черновик</button><button className="primary" data-next="plan" disabled={busy || uploadActive}>{busy && <Loader2 size={16} className="spin" />}Далее: когда опубликовать</button></div>
      </form>
    </Modal>}
    {schedule && <Modal title="Запланировать публикацию" close={() => !busy && setSchedule(null)}>
      <form onSubmit={event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void run(async () => {
          const useQueue = schedule.status === 'draft' && scheduleMode === 'queue';
          await post({ action: 'schedule', id: schedule.id, queue: useQueue || undefined, scheduledFor: useQueue ? undefined : schedule.status === 'uncertain' ? schedule.scheduledFor : `${String(form.get('date'))}:00+05:00` });
          await reload();
          setSchedule(null);
          setNotice('Публикация передана в расписание Zernio.');
        });
      }}>
        <div className="form-body">
          <p><strong>{schedule.title}</strong><br /><span className="muted">{state.profiles.find(profile => profile.id === schedule.profileId)?.name}</span></p>
          {schedule.status === 'draft' && <div className="choice">
            <label><input type="radio" name="mode" checked={scheduleMode === 'time'} onChange={() => setScheduleMode('time')} />В выбранное время</label>
            <label className={queueReady ? '' : 'off'}><input type="radio" name="mode" disabled={!queueReady} checked={scheduleMode === 'queue'} onChange={() => setScheduleMode('queue')} /><ListOrdered size={14} />В очередь{queueReady ? `, ближайший слот ${formatDate(queue!.nextSlots[0])}` : ' (автопубликация не настроена)'}</label>
          </div>}
          {(scheduleMode === 'time' || schedule.status !== 'draft') && <label>Дата и время по Кызылорде<input required name="date" type="datetime-local" min={minimumDate} disabled={schedule.status === 'uncertain'} defaultValue={schedule.status === 'uncertain' && schedule.scheduledFor ? new Date(Date.parse(schedule.scheduledFor) + 5 * 3600000).toISOString().slice(0, 16) : undefined} /></label>}
          {!scheduleConfigured && <p className="notice-bad"><AlertCircle size={15} />Для планирования добавьте ключ Zernio в этот профиль.</p>}
          {scheduleIssue && <p className="notice-bad" role="status"><AlertCircle size={15} /><span>{scheduleIssue}</span><button type="button" className="link" onClick={() => { setEditor(schedule); setSchedule(null); setError(''); }}>Редактировать</button></p>}
          {schedule.status === 'uncertain' && <p className="muted">Повторяем исходный запрос с тем же ключом. Содержимое и время не меняются.</p>}
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
        <div className="modal-footer"><button type="button" className="ghost" onClick={() => setSchedule(null)} disabled={busy}>Отмена</button><button className="primary" disabled={busy || !scheduleConfigured || Boolean(scheduleIssue)}>{busy && <Loader2 size={16} className="spin" />}{busy ? 'Отправляем…' : 'Запланировать'}</button></div>
      </form>
    </Modal>}
    {deleting && <Modal title="Удалить черновик?" close={() => !busy && setDeleting(null)}>
      <div className="form-body"><p className="muted">Черновик «{deleting.title}» будет удалён. Файл останется в медиатеке.</p>{error && <p className="error-text" role="alert">{error}</p>}</div>
      <div className="modal-footer"><button className="ghost" disabled={busy} onClick={() => setDeleting(null)}>Отмена</button><button className="danger" disabled={busy} onClick={() => run(async () => { await post({ action: 'deleteDraft', id: deleting.id }); await reload(); setDeleting(null); setNotice('Черновик удалён.'); })}>Удалить</button></div>
    </Modal>}
    {preview && <Modal title={preview.name} close={() => setPreview(null)} wide><div className="preview">{preview.type.startsWith('video') ? <video controls src={`/api/media?id=${preview.id}`} /> : <img src={`/api/media?id=${preview.id}`} alt={preview.name} />}</div></Modal>}
  </div>;
}
