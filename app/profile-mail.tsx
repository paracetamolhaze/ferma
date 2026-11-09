"use client";
import { useEffect, useId, useState, type FormEvent } from 'react';
import { ArrowLeft, Loader2, Paperclip, Pencil, RefreshCw } from 'lucide-react';
import { requestJson } from '@/lib/client-api';
import { mailDocument, MAIL_FRAME_SANDBOX } from '@/lib/mail-document';
import type { MailMessage, MailSummary } from '@/lib/mail';
import { CopyButton, formatTime } from './shared';

const REFRESH_MS = 15000;

export default function ProfileMail({ profileId, emailLocal, domain, onSaved, onOpenSettings }: { profileId: string; emailLocal: string | null; domain: string | null; onSaved: () => Promise<unknown>; onOpenSettings: () => void }) {
  const id = useId();
  const [local, setLocal] = useState(emailLocal || '');
  const [editing, setEditing] = useState(!emailLocal);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [emails, setEmails] = useState<MailSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [message, setMessage] = useState<MailMessage | null>(null);
  const [opening, setOpening] = useState('');
  const address = emailLocal && domain ? `${emailLocal}@${domain}` : '';

  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    try {
      const data = await requestJson<{ emails: MailSummary[] }>(`/api/mail?profileId=${profileId}`, { signal });
      if (signal?.aborted) return;
      setEmails(data.emails); setListError('');
    } catch (error) { if (!signal?.aborted) setListError(error instanceof Error ? error.message : 'Не удалось загрузить письма.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }
  useEffect(() => {
    if (!address) return;
    const controller = new AbortController();
    // A received code should appear without manual reloads while this profile is open.
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
      setLocal(data.local || ''); setEmails(null); setMessage(null); setEditing(!data.local);
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
  if (!domain) return <section className="panel"><header className="panel-head"><h2>Почта</h2></header><div className="panel-body"><p className="muted">Почта не подключена. <button type="button" className="link" onClick={onOpenSettings}>Открыть настройки</button></p></div></section>;
  const latest = emails?.find(email => email.code);
  return <section className="panel">
    <header className="panel-head">
      <h2>Почта и коды</h2>
      {address && !editing && <div className="panel-actions">
        <button type="button" className="ghost small" disabled={loading} onClick={() => void refresh()}>{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}Обновить</button>
      </div>}
    </header>
    <div className="panel-body">
      {editing || !address
        ? <form onSubmit={save}>
            <label htmlFor={id}>Адрес профиля</label>
            <div className="field-row">
              <span className="input-with-suffix"><input id={id} value={local} maxLength={64} spellCheck={false} autoComplete="off" autoFocus={Boolean(emailLocal)} placeholder="имя латиницей" disabled={saving} onChange={event => { setLocal(event.target.value); setSaveError(''); }} /><span>@{domain}</span></span>
              <button className="primary" disabled={saving || !local.trim() || local.trim().toLowerCase() === (emailLocal || '')}>{saving && <Loader2 size={15} className="spin" />}Сохранить</button>
              {emailLocal && <button type="button" className="ghost" onClick={() => { setLocal(emailLocal); setEditing(false); setSaveError(''); }}>Отмена</button>}
            </div>
            {saveError && <p className="error-text" role="alert">{saveError}</p>}
          </form>
        : <div className="address-line"><strong>{address}</strong><CopyButton value={address} label="Копировать" /><button type="button" className="ghost small" onClick={() => setEditing(true)}><Pencil size={14} />Изменить</button></div>}
      {listError && <p className="error-text" role="alert">{listError}</p>}
      {address && latest && !message && <div className="latest-code">
        <div><small>Последний код · {formatTime(latest.received_at)}</small><code>{latest.code}</code><small className="ellipsis">{latest.from_address}</small></div>
        <CopyButton value={latest.code!} label="Копировать код" />
      </div>}
      {address && message && <article className="mail-message">
        <button type="button" className="link" onClick={() => setMessage(null)}><ArrowLeft size={14} />Все письма</button>
        <h3>{message.subject || 'Без темы'}</h3>
        <p className="muted">От {message.from_address} · {formatTime(message.received_at)}{message.attachment_count ? ` · вложений: ${message.attachment_count}` : ''}</p>
        {message.html_content
          ? <iframe title="Текст письма" sandbox={MAIL_FRAME_SANDBOX} srcDoc={mailDocument(message.html_content)} />
          : <pre>{message.text_content || 'Письмо без текста.'}</pre>}
      </article>}
      {address && !message && emails && (emails.length
        ? <ul className="mail-list">{emails.map(email => <li key={email.id}>
            <button type="button" disabled={Boolean(opening)} onClick={() => void open(email.id)}>
              <span className="mail-main"><strong>{email.subject || 'Без темы'}</strong><small>{email.from_address}</small></span>
              {email.attachment_count > 0 && <Paperclip size={14} aria-label="Есть вложения" />}
              {opening === email.id ? <Loader2 size={14} className="spin" /> : <time>{formatTime(email.received_at)}</time>}
            </button>
            {email.code && <span className="code-chip"><code>{email.code}</code><CopyButton value={email.code} /></span>}
          </li>)}</ul>
        : <p className="muted">Писем пока нет. Список обновляется сам.</p>)}
    </div>
  </section>;
}
