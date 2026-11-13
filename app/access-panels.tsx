"use client";
import { useEffect, useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff, Loader2, Phone, ShieldCheck, Trash2, X } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import type { Offer } from '@/lib/fivesim';
import { CopyButton, formatDate, networkName, type Ctx, type Profile } from './shared';

type Order = { id: string; product: string; phone: string; country: string; price: string; status: string; code: string | null; expiresAt: string; createdAt: string };
type Entry = { platform: string; totp: { code: string; remaining: number } | null; backupTotal: number; backupLeft: number };
const post = <T,>(body: unknown) => requestJson<T>('/api/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const PRODUCT_NAMES: Record<string, string> = { instagram: 'Instagram', google: 'Google / YouTube', tiktok: 'TikTok' };
const PLATFORMS = [['instagram', 'Instagram'], ['threads', 'Threads'], ['google', 'Google / YouTube'], ['tiktok', 'TikTok'], ['other', 'Другое']];
const platformName = (id: string) => PLATFORMS.find(item => item[0] === id)?.[1] || networkName(id);
const ORDER_STATES: Record<string, string> = { PENDING: 'Готовим номер', RECEIVED: 'Ждём СМС', FINISHED: 'Завершён', CANCELED: 'Отменён', TIMEOUT: 'Время вышло', BANNED: 'Отклонён' };
const active = (order: Order) => ['PENDING', 'RECEIVED'].includes(order.status) && Date.parse(order.expiresAt) > Date.now();

function useNow(interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(timer); }, [interval]);
  return now;
}

function Numbers({ profile, ctx }: { profile: Profile; ctx: Ctx }) {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [offerList, setOfferList] = useState<Record<string, Offer | null> | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const now = useNow();
  const load = async () => setOrders((await requestJson<{ orders: Order[] }>(`/api/access?profileId=${profile.id}&view=orders`)).orders);
  useEffect(() => {
    if (!ctx.state.fivesim) return;
    // Orders and prices load once when the profile opens.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch(failure => setError(failure.message));
    void requestJson<Record<string, Offer | null>>('/api/access?view=offers').then(setOfferList).catch(() => setOfferList({}));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, ctx.state.fivesim]);
  const waiting = (orders || []).filter(order => !order.code && active(order)).map(order => order.id).join();
  useEffect(() => {
    if (!waiting) return;
    // A code usually arrives within a minute; checking every 5 seconds shows it promptly.
    const timer = setInterval(() => {
      for (const id of waiting.split(',')) void post<Order>({ action: 'check', id }).then(updated => setOrders(current => current?.map(item => item.id === id ? { ...item, ...updated } : item) || null)).catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [waiting]);
  async function run(key: string, work: () => Promise<void>) {
    setBusy(key); setError('');
    try { await work(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка.'); }
    finally { setBusy(''); }
  }
  const buy = (product: string) => run(product, async () => { const order = await post<Order>({ action: 'buy', profileId: profile.id, product }); setOrders(current => [order, ...(current || [])]); });
  const change = (id: string, action: 'finish' | 'cancel') => run(id + action, async () => { const updated = await post<Order>({ action, id }); setOrders(current => current?.map(item => item.id === id ? { ...item, ...updated } : item) || null); });
  if (!ctx.state.fivesim) return <section className="panel"><header className="panel-head"><h2>Номер для кода</h2></header><div className="panel-body"><p className="muted">5SIM не подключён. <button className="link" onClick={() => ctx.go('settings')}>Вставить ключ API</button></p></div></section>;
  const current = (orders || []).filter(active);
  const past = (orders || []).filter(order => !active(order));
  return <section className="panel">
    <header className="panel-head"><h2>Номер для кода</h2></header>
    <div className="panel-body">
      <p className="muted">Разовый номер 5SIM: введите его на сайте, код появится здесь. Если код не пришёл, отмените заказ, и деньги вернутся на баланс 5SIM.</p>
      <div className="social-import-actions">{Object.keys(PRODUCT_NAMES).map(product => {
        const offer = offerList?.[product];
        return <button key={product} className="ghost" disabled={Boolean(busy) || offer === null} onClick={() => void buy(product)}>
          {busy === product ? <Loader2 size={15} className="spin" /> : <Phone size={15} />}{PRODUCT_NAMES[product]}{offer ? ` · ${offer.cost}` : offer === null ? ' · нет номеров' : ''}
        </button>;
      })}</div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {current.map(order => {
        const left = Math.max(0, Math.floor((Date.parse(order.expiresAt) - now) / 1000));
        return <div className="order-card" key={order.id}>
          <div className="order-main">
            <small>{PRODUCT_NAMES[order.product] || order.product} · {order.country} · осталось {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</small>
            <span className="address-line"><strong>+{order.phone.replace(/^\+/, '')}</strong><CopyButton value={`+${order.phone.replace(/^\+/, '')}`} label="Копировать номер" /></span>
            {order.code ? <span className="code-chip big"><code>{order.code}</code><CopyButton value={order.code} label="Копировать код" /></span> : <span className="muted"><Loader2 size={14} className="spin" /> Ждём СМС…</span>}
          </div>
          <div className="order-actions">
            {order.code ? <button className="primary small" disabled={Boolean(busy)} onClick={() => void change(order.id, 'finish')}><Check size={14} />Готово</button>
              : <button className="ghost small" disabled={Boolean(busy)} onClick={() => void change(order.id, 'cancel')}><X size={14} />Отменить</button>}
          </div>
        </div>;
      })}
      {past.length > 0 && <details className="history"><summary>Прошлые номера: {past.length}</summary><ul className="plain-list">{past.map(order =>
        <li key={order.id}><span className="post-text"><strong>+{order.phone.replace(/^\+/, '')}</strong><small>{PRODUCT_NAMES[order.product] || order.product} · {formatDate(order.createdAt)}{order.code ? ` · код ${order.code}` : ''}</small></span><span className="pill plain">{ORDER_STATES[order.status] || order.status}</span></li>)}</ul></details>}
      <p className="muted small-note">Разовый номер потом уйдёт другому. Сразу включите вход через приложение ниже и сохраните резервные коды.</p>
    </div>
  </section>;
}

function EntryCard({ profile, entry, onChanged }: { profile: Profile; entry: Entry; onChanged: () => void }) {
  const [codes, setCodes] = useState<{ code: string; used: boolean }[] | null>(null);
  const [error, setError] = useState('');
  const now = useNow();
  const remaining = entry.totp ? Math.max(0, entry.totp.remaining - Math.floor((now - (entry as Entry & { loadedAt: number }).loadedAt) / 1000)) : 0;
  useEffect(() => { if (entry.totp && remaining === 0) onChanged(); }, [remaining, entry.totp, onChanged]);
  async function toggle() {
    setError('');
    if (codes) { setCodes(null); return; }
    try { setCodes((await post<{ codes: { code: string; used: boolean }[] }>({ action: 'revealBackup', profileId: profile.id, platform: entry.platform })).codes); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка.'); }
  }
  async function mark(code: string, used: boolean) {
    try { setCodes((await post<{ codes: { code: string; used: boolean }[] }>({ action: 'markBackup', profileId: profile.id, platform: entry.platform, code, used })).codes); onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка.'); }
  }
  async function remove() {
    if (!window.confirm(`Удалить ключ и резервные коды ${platformName(entry.platform)} из FERMA? В самой соцсети защита останется включённой.`)) return;
    try { await post({ action: 'remove', profileId: profile.id, platform: entry.platform }); onChanged(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка.'); }
  }
  return <div className="secret-card">
    <div className="secret-head"><strong>{platformName(entry.platform)}</strong><button className="icon-button" aria-label="Удалить" title="Удалить" onClick={() => void remove()}><Trash2 size={15} /></button></div>
    {entry.totp ? <div className="totp"><code>{entry.totp.code.replace(/(\d{3})(\d{3})/, '$1 $2')}</code><CopyButton value={entry.totp.code} label="Копировать" /><span className="totp-timer" style={{ ['--left' as string]: `${(remaining / 30) * 100}%` }}>{remaining} с</span></div>
      : <p className="muted">Ключа приложения нет.</p>}
    {entry.backupTotal > 0 ? <div>
      <button className="ghost small" onClick={() => void toggle()}>{codes ? <EyeOff size={14} /> : <Eye size={14} />}Резервные коды: осталось {entry.backupLeft} из {entry.backupTotal}</button>
      {codes && <ul className="backup-codes">{codes.map(item => <li key={item.code} className={item.used ? 'used' : ''}>
        <code>{item.code}</code>{!item.used && <CopyButton value={item.code} />}
        <button className="link" onClick={() => void mark(item.code, !item.used)}>{item.used ? 'вернуть' : 'использован'}</button>
      </li>)}</ul>}
    </div> : <p className="muted">Резервных кодов нет.</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </div>;
}

function TwoFactor({ profile }: { profile: Profile }) {
  const [entries, setEntries] = useState<(Entry & { loadedAt: number })[] | null>(null);
  const [platform, setPlatform] = useState('instagram');
  const [secret, setSecret] = useState('');
  const [backup, setBackup] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const load = async () => {
    const data = await requestJson<{ entries: Entry[] }>(`/api/access?profileId=${profile.id}`);
    setEntries(data.entries.map(entry => ({ ...entry, loadedAt: Date.now() })));
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch(failure => setError(failure.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError(''); setSaved('');
    try {
      const done: string[] = [];
      if (secret.trim()) { const code = await post<{ code: string }>({ action: 'totp', profileId: profile.id, platform, secret }); done.push(`ключ сохранён, текущий код ${code.code}: введите его в ${platformName(platform)} для подтверждения`); }
      if (backup.trim()) { const result = await post<{ saved: number }>({ action: 'backup', profileId: profile.id, platform, text: backup }); done.push(`резервных кодов: ${result.saved}`); }
      setSecret(''); setBackup(''); setSaved(done.join('; '));
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить.'); }
    finally { setSaving(false); }
  }
  return <section className="panel">
    <header className="panel-head"><h2>Вход через приложение</h2></header>
    <div className="panel-body">
      {entries?.length ? <div className="secret-grid">{entries.map(entry => <EntryCard key={entry.platform} profile={profile} entry={entry} onChanged={() => void load()} />)}</div>
        : entries && <p className="muted">Пока ничего не добавлено.</p>}
      <form className="form-stack" onSubmit={submit}>
        <p className="muted">В соцсети включите двухфакторную защиту через приложение, выберите «Ввести ключ вручную» и вставьте ключ сюда. FERMA будет показывать код вместо Google Authenticator.</p>
        <label>Соцсеть<select value={platform} disabled={saving} onChange={event => setPlatform(event.target.value)}>{PLATFORMS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>Ключ приложения<input autoComplete="off" spellCheck={false} maxLength={600} placeholder="Например, ABCD EFGH IJKL MNOP" value={secret} disabled={saving} onChange={event => setSecret(event.target.value)} /></label>
        <label>Резервные коды <span className="hint">вставьте как выдала соцсеть</span><textarea rows={4} maxLength={5000} spellCheck={false} value={backup} disabled={saving} onChange={event => setBackup(event.target.value)} /></label>
        {error && <p className="error-text" role="alert">{error}</p>}
        {saved && <p className="key-saved" role="status"><Check size={16} />{saved}</p>}
        <button className="primary" disabled={saving || (!secret.trim() && !backup.trim())}>{saving ? <Loader2 size={15} className="spin" /> : <ShieldCheck size={15} />}Сохранить</button>
      </form>
      <p className="muted small-note">Сохраните резервные коды ещё и вне FERMA: если пропадёт компьютер и бэкап, они последний способ войти.</p>
    </div>
  </section>;
}

export function ProfileAccess({ profile, ctx }: { profile: Profile; ctx: Ctx }) {
  return <div className="columns"><Numbers profile={profile} ctx={ctx} /><TwoFactor profile={profile} /></div>;
}

export function FivesimSettings({ ctx }: { ctx: Ctx }) {
  const [apiKey, setApiKey] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!ctx.state.fivesim) return;
    requestJson<{ balance: number }>('/api/access?view=balance').then(data => setBalance(data.balance)).catch(failure => setError(failure.message));
  }, [ctx.state.fivesim]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setError('');
    try { setBalance((await post<{ balance: number }>({ action: 'fivesimKey', apiKey: apiKey.trim() })).balance); setApiKey(''); await ctx.reload(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить ключ.'); }
    finally { setSaving(false); }
  }
  return <section className="panel">
    <header className="panel-head"><h2>Номера 5SIM</h2><span className={`pill ${ctx.state.fivesim ? 'good' : 'plain'}`}>{ctx.state.fivesim ? `Баланс: ${balance ?? '…'}` : 'Не подключено'}</span></header>
    <div className="panel-body">
      <form className="api-key-form" onSubmit={submit}>
        <p className="muted">Ключ API находится на <a className="link" href="https://5sim.net/settings/security" target="_blank" rel="noreferrer">5sim.net → Профиль → API</a>. Баланс пополняется на сайте 5SIM.</p>
        <label>{ctx.state.fivesim ? 'Новый ключ API' : 'Ключ API'}<input type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={saving} onChange={event => setApiKey(event.target.value)} /></label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="primary" disabled={saving || apiKey.trim().length < 10}>{saving && <Loader2 size={15} className="spin" />}Проверить и сохранить</button>
      </form>
    </div>
  </section>;
}
