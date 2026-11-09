"use client";
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, Copy, Loader2, Mail, Paperclip, RefreshCw } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import { mailDocument, MAIL_FRAME_SANDBOX } from '@/lib/mail-document';
import type { MailMessage, MailSummary } from '@/lib/mail';

const REFRESH_MS = 20000;
const received = (seconds: number) => new Date(seconds * 1000).toLocaleString('ru-RU', { timeZone: 'Asia/Qyzylorda', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export default function ProfileMail({ profileId, emailLocal, domain, onSaved, onOpenSettings }: { profileId: string; emailLocal: string | null; domain: string | null; onSaved: () => Promise<unknown>; onOpenSettings: () => void }) {
  const id = useId();
  const [local, setLocal] = useState(emailLocal || '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [copied, setCopied] = useState(false);
  const [emails, setEmails] = useState<MailSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [opening, setOpening] = useState('');
  const address = emailLocal && domain ? `${emailLocal}@${domain}` : '';

  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    try {
      const data = await requestJson<{ emails: MailSummary[]; total: number }>(`/api/mail?profileId=${profileId}`, { signal });
      if (signal?.aborted) return;
      setEmails(data.emails); setTotal(data.total); setListError('');
    } catch (error) { if (!signal?.aborted) setListError(error instanceof Error ? error.message : 'Не удалось загрузить письма.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => {
    if (!address) return;
    const controller = new AbortController();
    // A received code should appear without manual reloads while this card is open.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(controller.signal);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(controller.signal); }, REFRESH_MS);
    return () => { clearInterval(timer); controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, address]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setSaveError('');
    try {
      const data = await requestJson<{ local: string | null }>('/api/mail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'address', profileId, local }) });
      setLocal(data.local || ''); setEmails(null); setMessage(null);
      await onSaved();
    } catch (error) { setSaveError(error instanceof Error ? error.message : 'Не удалось сохранить адрес.'); }
    finally { setSaving(false); }
  }
  async function open(emailId: string) {
    setOpening(emailId); setListError('');
    try { setMessage(await requestJson<MailMessage>(`/api/mail?profileId=${profileId}&id=${encodeURIComponent(emailId)}`)); }
    catch (error) { setListError(error instanceof Error ? error.message : 'Не удалось открыть письмо.'); }
    finally { setOpening(''); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { setSaveError('Не удалось скопировать адрес.'); }
  }

  return <section className="profile-mail-section">
    <div className="section-title"><h3>Почта</h3>{address && <span>{total}</span>}</div>
    {!domain ? <div className="form-note"><Mail size={17} /><span>Почтовый сервис не подключён. <button type="button" className="text-button" onClick={onOpenSettings}>Открыть настройки</button></span></div> : <>
      <form className="profile-mail-form" onSubmit={save}>
        <label htmlFor={id}>Адрес профиля</label>
        <div className="profile-name-row">
          <input className="form-control" id={id} value={local} maxLength={64} spellCheck={false} autoComplete="off" placeholder="имя латиницей" disabled={saving} onChange={event => { setLocal(event.target.value); setSaveError(''); }} />
          <span className="mail-domain">@{domain}</span>
          <button className="secondary" disabled={saving || local.trim().toLowerCase() === (emailLocal || '')}>{saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />}Сохранить</button>
        </div>
        {saveError && <p className="error-text" role="alert">{saveError}</p>}
      </form>
      {address && <div className="mail-toolbar">
        <strong>{address}</strong>
        <button type="button" className="secondary" onClick={() => void copy()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Скопировано' : 'Копировать'}</button>
        <button type="button" className="secondary" disabled={loading} onClick={() => void refresh()}>{loading ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}Обновить</button>
      </div>}
      {listError && <p className="error-text" role="alert">{listError}</p>}
      {address && message && <article className="mail-message">
        <button type="button" className="text-button" onClick={() => setMessage(null)}><ArrowLeft size={15} />Все письма</button>
        <h4>{message.subject || 'Без темы'}</h4>
        <p className="muted">От {message.from_address} · {received(message.received_at)}{message.attachment_count ? ` · вложений: ${message.attachment_count}` : ''}</p>
        {message.html_content
          ? <iframe title="Текст письма" sandbox={MAIL_FRAME_SANDBOX} srcDoc={mailDocument(message.html_content)} />
          : <pre>{message.text_content || 'Письмо без текста.'}</pre>}
        {message.html_content && <p className="muted">Внешние картинки отключены.</p>}
      </article>}
      {address && !message && emails && (emails.length
        ? <ul className="mail-list">{emails.map(email => <li key={email.id}><button type="button" disabled={Boolean(opening)} onClick={() => void open(email.id)}>
            <span><strong>{email.subject || 'Без темы'}</strong><small>{email.from_address}</small></span>
            {email.attachment_count > 0 && <Paperclip size={14} />}
            {opening === email.id ? <Loader2 size={15} className="spin" /> : <time>{received(email.received_at)}</time>}
          </button></li>)}</ul>
        : <p className="form-note"><Mail size={17} />Писем пока нет. Список обновляется сам.</p>)}
    </>}
  </section>;
}
