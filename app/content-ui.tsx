"use client";
/** Small pieces shared by the FERMA 2.0 screens: loading an API, running an action, names, checks. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import type { Ctx } from './shared';

export type Loaded<T> = { data: T | null; error: string; loading: boolean; reload: () => Promise<void> };
/** Reads a FERMA API; with everyMs it follows changes while the tab is visible. */
export function useApi<T>(url: string | null, everyMs = 0): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(Boolean(url));
  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try { setData(await requestJson<T>(url)); setError(''); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Нет данных.'); }
    finally { setLoading(false); }
  }, [url]);
  useEffect(() => {
    // Initial load and polling; state changes only after each request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
    if (!everyMs) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void reload(); }, everyMs);
    return () => clearInterval(timer);
  }, [reload, everyMs]);
  return { data, error, loading, reload };
}
export const send = <T,>(url: string, body: unknown) => requestJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** One action at a time per screen: its key shows the spinner, its error stays until the next action. */
export function useAction(ctx: Ctx) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function run(key: string, work: () => Promise<unknown>, done?: string) {
    setBusy(key); setError('');
    try { await work(); if (done) ctx.notify(done); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не получилось.'); }
    finally { setBusy(''); }
  }
  return { busy, error, setError, run };
}
export const ErrorLine = ({ text }: { text: string }) => text ? <p className="notice-bad" role="alert"><AlertCircle size={15} /><span>{text}</span></p> : null;
export const Spin = ({ on, children }: { on: boolean; children: ReactNode }) => <>{on ? <Loader2 size={15} className="spin" /> : children}</>;
export const Loading = ({ text = 'Загружаем…' }: { text?: string }) => <p className="muted"><Loader2 className="spin" size={16} /> {text}</p>;
export const fileUrl = (key: string) => `/api/content?file=${encodeURIComponent(key)}`;
export const words = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);
export const plural = (count: number, one: string, few: string, many: string) => {
  const tens = count % 100, units = count % 10;
  return tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many;
};

export const KIND_NAMES: Record<string, string> = { news: 'Новость', carousel: 'Карусель', video_carousel: 'Видеокарусель', video: 'Видео' };
export const FORMAT_NAMES: Record<string, string> = { text: 'Текст', image: 'Картинка', carousel: 'Карусель' };
export const MODE_NAMES: Record<string, string> = { draft: 'Только черновики', manual: 'С вашим одобрением', auto: 'Сами после проверки' };
export const PLATFORM_NAMES: Record<string, string> = { threads: 'Threads', instagram: 'Instagram' };
/** Insight names as the networks call them, in the owner's words. */
export const METRIC_NAMES: Record<string, string> = { views: 'просмотры', reach: 'охват', likes: 'лайки', replies: 'ответы', reposts: 'репосты', quotes: 'цитаты', shares: 'поделились', comments: 'комментарии', saved: 'сохранения', total_interactions: 'всего реакций' };
export const metricsLine = (stats: Record<string, number>) => Object.entries(stats).map(([key, value]) => `${METRIC_NAMES[key] || key}: ${value.toLocaleString('ru-RU')}`).join(' · ');
export const bytesText = (bytes: number) => bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : bytes < 1073741824 ? `${(bytes / 1048576).toFixed(1).replace('.', ',')} МБ` : `${(bytes / 1073741824).toFixed(2).replace('.', ',')} ГБ`;

export type Check = { key: string; label: string; state: 'ok' | 'warn' | 'fail' | 'skip'; detail: string };
const CHECK_PILLS: Record<Check['state'], [string, string]> = { ok: ['В порядке', 'good'], warn: ['Внимание', 'info'], fail: ['Не работает', 'bad'], skip: ['Не проверяется', 'plain'] };
/** The result of a diagnostics run: one line per check, Meta's own reason in the text. */
export function CheckList({ checks }: { checks: Check[] }) {
  return <ul className="plain-list">{checks.map(check => <li key={check.key}>
    <span className="post-text"><strong>{check.label}</strong><small className={check.state === 'fail' ? 'error-text' : 'muted wrap'}>{check.detail}</small></span>
    <span className={`pill ${CHECK_PILLS[check.state][1]}`}>{CHECK_PILLS[check.state][0]}</span>
  </li>)}</ul>;
}
/** Kyzylorda time (UTC+5) for datetime-local inputs, like the rest of the dashboard. */
export const toLocalInput = (iso: string) => new Date(Date.parse(iso) + 5 * 3600_000).toISOString().slice(0, 16);
export const fromLocalInput = (value: string) => new Date(`${value}:00+05:00`).toISOString();
