"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { missingNetworks, NETWORKS } from '@/lib/domain';
import { requestJson } from '@/lib/client-api';
import { colorText } from '@/lib/profile-colors';

export type Profile = { configured: boolean; id: string; name: string; description: string; color: string; emailLocal: string | null; phone: string | null; smsLine: string | null; avatar: string | null; createdAt: string };
export type Channel = { id: string; profileId: string; platform: string; username: string | null; state: string; accountId: string | null };
export type Media = { id: string; name: string; type: string; size: number; createdAt: string };
export type Post = { id: string; profileId: string; zernioId: string | null; title: string; content: string; mediaId: string | null; platforms: string; status: string; scheduledFor: string | null; error: string | null };
export type State = { profiles: Profile[]; channels: Channel[]; media: Media[]; posts: Post[]; canSaveKey: boolean; mail: { baseUrl: string; domain: string } | null; sms: { baseUrl: string; webhookUrl: string } | null; fivesim: boolean };
export const initialState: State = { profiles: [], channels: [], media: [], posts: [], canSaveKey: false, mail: null, sms: null, fivesim: false };

/** What every screen needs from the shell. */
export type Ctx = {
  state: State;
  busy: boolean;
  reload: () => Promise<State>;
  go: (route: string) => void;
  compose: (profileId?: string, mediaId?: string) => void;
  edit: (post: Post) => void;
  plan: (post: Post) => void;
  remove: (post: Post) => void;
  addProfile: () => void;
  bulk: (profileId?: string) => void;
  notify: (text: string) => void;
};

export const statusNames: Record<string, string> = {
  draft: 'Черновик', sending: 'Отправляется', uncertain: 'Сверяем с соцсетью', scheduled: 'Запланировано', publishing: 'Публикуется',
  pending_approval: 'Ждёт одобрения', published: 'Опубликовано', failed: 'Ошибка', partial: 'Частично', processing: 'Соцсеть обрабатывает',
  cancelled: 'Отменено', external: 'В прежнем кабинете',
  importing: 'Загружается', ready: 'Готово', duplicate: 'Повтор', ignored: 'Скрыт', planned: 'Ждёт текста', writing: 'Пишется', reviewing: 'Читает редактор', written: 'Ждёт аккаунта',
  rendering: 'Рисуется', review: 'Ждёт вашей проверки', rejected: 'Отклонён', outdated: 'Устарел', archived: 'В архиве', awaiting_approval: 'Ждёт одобрения', preparing: 'Готовится',
  connected: 'Подключён', expired: 'Нужен вход', disabled: 'Отключён', active: 'Работает', paused: 'На паузе', ok: 'В порядке', error: 'Ошибка', syncing: 'Синхронизация',
  idle: 'Ожидание', stored: 'Сохранён', deferred: 'Позже', skipped: 'Пропущен', queued: 'В очереди', running: 'Идёт', done: 'Готово',
};
export const problemStatuses = ['failed', 'uncertain', 'partial', 'external'];
const attentionStatuses = ['review', 'expired', 'error', 'rejected', 'awaiting_approval'];
const goodStatuses = ['published', 'ready', 'connected', 'active', 'ok', 'stored', 'done'];
const zone = 'Asia/Qyzylorda';
export const formatDate = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const formatTime = (seconds: number) => new Date(seconds * 1000).toLocaleString('ru-RU', { timeZone: zone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const formatNumber = (value: number) => value.toLocaleString('ru-RU');
export const networkName = (platform: string) => NETWORKS.find(item => item.id === platform)?.name || platform;

export function Network({ platform, username }: { platform: string; username?: string | null }) {
  const known = NETWORKS.some(item => item.id === platform);
  return <span className="network" title={networkName(platform)}>
    {known ? <img src={`/icons/${platform === 'twitter' ? 'x' : platform}.svg`} alt={networkName(platform)} width={16} height={16} /> : <span className="network-name">{networkName(platform)}</span>}
    {username && <span>@{username.replace(/^@/, '')}</span>}
  </span>;
}
export const avatarUrl = (profile: Pick<Profile, 'id' | 'avatar'>) => `/api/avatar?profileId=${profile.id}&v=${profile.avatar}`;
export function Avatar({ profile, size }: { profile: Pick<Profile, 'name' | 'color'> & Partial<Pick<Profile, 'id' | 'avatar'>>; size?: 'large' }) {
  if (profile.id && profile.avatar) return <img className={`avatar ${size || ''}`} src={avatarUrl({ id: profile.id, avatar: profile.avatar })} alt="" />;
  return <span className={`avatar ${size || ''}`} style={{ background: profile.color, color: colorText(profile.color) }}>{profile.name.slice(0, 2).toUpperCase()}</span>;
}
export function StatusPill({ status }: { status: string }) {
  const tone = goodStatuses.includes(status) ? 'good' : problemStatuses.includes(status) || attentionStatuses.includes(status) ? 'bad' : ['draft', 'cancelled', 'paused', 'disabled', 'outdated', 'archived', 'ignored', 'duplicate', 'idle', 'skipped', 'deferred'].includes(status) ? 'plain' : 'info';
  return <span className={`pill ${tone}`}>{statusNames[status] || status}</span>;
}
export function CopyButton({ value, label, onCopied }: { value: string; label?: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy(event: React.MouseEvent) {
    event.stopPropagation();
    try { await navigator.clipboard.writeText(value); setCopied(true); onCopied?.(); setTimeout(() => setCopied(false), 1500); }
    catch { window.prompt('Скопируйте вручную:', value); }
  }
  return <button type="button" className={label ? 'ghost small' : 'icon-button'} aria-label={`Скопировать ${value}`} title="Скопировать" onClick={event => void copy(event)}>
    {copied ? <Check size={14} /> : <Copy size={14} />}{label && (copied ? 'Скопировано' : label)}
  </button>;
}
export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} aria-labelledby={titleId} className={wide ? 'wide' : ''} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === ref.current) close(); }}>
    <div className="modal-head"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={close} aria-label="Закрыть"><X size={18} /></button></div>
    {children}
  </dialog>;
}
export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><strong>{title}</strong>{text && <p>{text}</p>}{action}</div>;
}
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; text: string; count?: number }[]; onChange: (value: T) => void; label: string }) {
  return <div className="segmented" role="group" aria-label={label}>{options.map(option =>
    <button key={option.id} type="button" aria-pressed={value === option.id} onClick={() => onChange(option.id)}>{option.text}{option.count !== undefined && <span>{option.count}</span>}</button>)}</div>;
}

export type Loaded<T> = { loading?: boolean; data?: T; error?: string };
/** Reads /api/zernio for several profiles, at most three at a time; every key has its own limits. */
export function useZernio<T>(profiles: Pick<Profile, 'id'>[], query: string, revision = 0) {
  const [results, setResults] = useState<Record<string, Loaded<T>>>({});
  const ids = profiles.map(profile => profile.id).join();
  useEffect(() => {
    const controller = new AbortController();
    const list = ids ? ids.split(',') : [];
    // Each change of the request starts its own loading state for all listed profiles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResults(Object.fromEntries(list.map(id => [id, { loading: true }])));
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const id = list[next++];
        try {
          const data = await requestJson<T>(`/api/zernio?profileId=${id}&${query}`, { signal: controller.signal });
          if (!controller.signal.aborted) setResults(current => ({ ...current, [id]: { data } }));
        } catch (error) {
          if (!controller.signal.aborted) setResults(current => ({ ...current, [id]: { error: error instanceof Error ? error.message : 'Нет данных.' } }));
        }
      }
    };
    for (let i = 0; i < 3; i++) void worker();
    return () => controller.abort();
  }, [ids, query, revision]);
  return results;
}
export const connectedNetworks = (profileId: string, state: State) => state.channels.filter(channel => channel.profileId === profileId && channel.state === 'connected').map(channel => channel.platform);
export const needsSetup = (profile: Profile, state: State) =>
  !profile.configured || missingNetworks(connectedNetworks(profile.id, state)).length > 0 || (Boolean(state.mail) && !profile.emailLocal);
