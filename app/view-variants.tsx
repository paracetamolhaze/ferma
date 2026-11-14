"use client";
/** «Варианты»: what FERMA made of each Gudini material, with Gudini's own pictures and the AI editor's notes. */
import { useState } from 'react';
import { Check, Pencil, RotateCcw, X } from 'lucide-react';
import { ErrorLine, fileUrl, FORMAT_NAMES, KIND_NAMES, Loading, send, Spin, useAction, useApi } from './content-ui';
import { Empty, formatDate, Modal, Network, Segmented, StatusPill, type Ctx } from './shared';

type Review = { score?: number; summary?: string; unverified?: string[]; contradicted?: string[]; issues?: string[]; approvedByOwnerAt?: string };
type VariantRow = {
  id: string; slot: number; style: string; styleName: string; format: string; layout: string; layoutName: string; status: string; headline: string | null; text: string | null; caption: string | null;
  error: string | null; profileId: string | null; platform: string | null; aiImagery: boolean; palette: string | null; preview: string | null; cards: number;
  score: number | null; review: Review | null; editedByOwner: boolean;
};
type ItemRow = { id: string; kind: string; title: string; readyAt: string | null; categories: string[]; urgent: boolean; variants: VariantRow[] };
type VariantsData = { settings: { variantsPerItem: number; dailyWriterCalls: number; used: number }; items: ItemRow[] };
type Filter = 'all' | 'owner' | 'ready' | 'work' | 'off';
const GROUPS: Record<Filter, string[]> = { all: [], owner: ['review'], ready: ['ready', 'written', 'rendering'], work: ['planned', 'writing', 'reviewing'], off: ['rejected', 'failed', 'archived'] };

function CardsModal({ variant, close }: { variant: VariantRow; close: () => void }) {
  const files = useApi<{ files: { key: string }[] }>(`/api/content?view=variantFiles&variantId=${variant.id}`);
  return <Modal title={`Вариант ${variant.slot + 1}: ${variant.layoutName}`} close={close} wide>
    <div className="form-body">{files.loading ? <Loading /> : files.data?.files.length
      ? <div className="media-grid">{files.data.files.map((file, index) => <a key={file.key} className="media-card" href={fileUrl(file.key)} target="_blank" rel="noreferrer" title="Открыть в полном размере"><img loading="lazy" src={fileUrl(file.key)} alt={`Карточка ${index + 1}`} /></a>)}</div>
      : <p className="muted">{variant.layout === 'gudini' ? 'Gudini нарисует карточки, когда вариант достанется аккаунту: в его цвете и с его именем.' : 'Картинок нет.'}</p>}</div>
  </Modal>;
}

function EditModal({ ctx, variant, close, onSaved }: { ctx: Ctx; variant: VariantRow; close: () => void; onSaved: () => void }) {
  const [text, setText] = useState(variant.text || '');
  const [caption, setCaption] = useState(variant.caption || '');
  const action = useAction(ctx);
  const withCaption = variant.layout === 'original' || variant.layout === 'gudini';
  const captionLimit = variant.layout === 'gudini' ? 600 : 1800;
  return <Modal title={`Правка варианта ${variant.slot + 1}`} close={close} wide>
    <form onSubmit={event => { event.preventDefault(); void action.run('save', async () => { const result = await send<{ status: string }>('/api/content', { action: 'editVariant', variantId: variant.id, text, caption: withCaption ? caption : undefined }); onSaved(); close(); ctx.notify(result.status === 'reviewing' ? 'Сохранено. Вариант перечитает ИИ-редактор.' : 'Сохранено.'); }); }}>
      <div className="form-body form-stack">
        <label>Текст для Threads<textarea rows={5} maxLength={480} value={text} onChange={event => setText(event.target.value)} /><small className="muted">{text.length} из 480</small></label>
        {withCaption && <label>Подпись для Instagram<textarea rows={7} maxLength={captionLimit} value={caption} onChange={event => setCaption(event.target.value)} /><small className="muted">{caption.length} из {captionLimit}</small></label>}
        <small className="muted">При сохранении FERMA сверяет числа, даты, имена, цитаты и ссылки с материалом Gudini. Картинки варианта не меняются.</small>
        <ErrorLine text={action.error} />
      </div>
      <div className="modal-footer"><button type="button" className="ghost" onClick={close}>Отмена</button><button className="primary" disabled={Boolean(action.busy) || !text.trim()}><Spin on={action.busy === 'save'}><Check size={15} /></Spin>Сохранить</button></div>
    </form>
  </Modal>;
}

/** The AI editor's verdict in short: the rating, its reason, and every claim it could not confirm. */
function EditorNotes({ variant }: { variant: VariantRow }) {
  const review = variant.review;
  if (variant.status === 'reviewing') return <small className="muted">читает ИИ-редактор</small>;
  if (!review && variant.score === null) return <small className="muted">{variant.editedByOwner ? 'исправлено вами' : '—'}</small>;
  return <span className="post-text">
    {variant.score !== null && <strong>{variant.score} из 100</strong>}
    {review?.summary && <small>{review.summary}</small>}
    {review?.contradicted?.map(claim => <small key={claim} className="error-text">Противоречит источникам: «{claim}»</small>)}
    {review?.unverified?.map(claim => <small key={claim} className="error-text">Нет в источниках: «{claim}»</small>)}
    {review?.issues?.slice(0, 3).map(issue => <small key={issue} className="muted">{issue}</small>)}
    {review?.approvedByOwnerAt && <small className="muted">одобрено вами</small>}
    {variant.editedByOwner && <small className="muted">текст исправлен вами</small>}
  </span>;
}

export function VariantsView({ ctx, itemId }: { ctx: Ctx; itemId?: string }) {
  const view = useApi<VariantsData>(`/api/content?view=variants${itemId ? `&itemId=${itemId}` : ''}`, 20000);
  const action = useAction(ctx);
  const [filter, setFilter] = useState<Filter>('all');
  const [cards, setCards] = useState<VariantRow | null>(null);
  const [editing, setEditing] = useState<VariantRow | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const data = view.data;
  if (view.loading && !data) return <Loading />;
  const profileName = (id: string | null) => ctx.state.profiles.find(profile => profile.id === id)?.name;
  const all = (data?.items || []).flatMap(item => item.variants);
  const count = (value: Filter) => all.filter(variant => value === 'all' || GROUPS[value].includes(variant.status)).length;
  const items = (data?.items || []).map(item => ({ ...item, variants: item.variants.filter(variant => filter === 'all' || GROUPS[filter].includes(variant.status)) })).filter(item => item.variants.length || filter === 'all');
  const act = (variant: VariantRow, body: Record<string, unknown>, done: string) => action.run(variant.id, async () => { await send('/api/content', body); await view.reload(); }, done);
  return <div className="stack">
    <ErrorLine text={view.error || action.error} />
    {data && <div className="toolbar">
      <Segmented label="Варианты" value={filter} onChange={setFilter} options={[{ id: 'all', text: 'Все', count: count('all') }, { id: 'owner', text: 'Ждут вашей проверки', count: count('owner') }, { id: 'ready', text: 'Готовы', count: count('ready') }, { id: 'work', text: 'Пишутся и проверяются', count: count('work') }, { id: 'off', text: 'Отклонены', count: count('off') }]} />
      <span className="toolbar-note">Обращений к GPT-мосту сегодня: {data.settings.used} из {data.settings.dailyWriterCalls}</span>
      {itemId && <button className="link" onClick={() => ctx.go('variants')}>Все материалы</button>}
    </div>}
    {items.length ? items.map(item => <section className="panel" key={item.id}>
      <header className="panel-head"><h2>{item.title}</h2><span className="muted">{[KIND_NAMES[item.kind] || item.kind, item.urgent ? 'срочно' : '', ...item.categories].filter(Boolean).join(' · ')}{item.readyAt ? ` · ${formatDate(item.readyAt)}` : ''}</span></header>
      {item.variants.length ? <div className="table-scroll"><table className="variants">
        <thead><tr><th>Картинки</th><th>Вариант</th><th>Текст</th><th>ИИ-редактор</th><th /></tr></thead>
        <tbody>{item.variants.map(variant => <tr key={variant.id}>
          <td>{variant.preview ? <button className="variant-thumb" title="Все карточки" onClick={() => setCards(variant)}><img loading="lazy" src={fileUrl(variant.preview)} alt="" />{variant.cards > 1 && <span>{variant.cards}</span>}</button>
            : <button className="variant-thumb empty" disabled={variant.layout !== 'gudini'} title={variant.layout === 'gudini' ? 'Карточки' : 'Без картинок'} onClick={() => setCards(variant)}>{variant.layout === 'gudini' ? '…' : 'Aa'}</button>}</td>
          <td><span className="post-text"><strong>{variant.slot + 1}. {variant.styleName}</strong><small>{FORMAT_NAMES[variant.format] || variant.format} · {variant.layoutName}</small>{variant.palette && <small className="muted">цвет: {variant.palette}</small>}
            <span className="variant-state"><StatusPill status={variant.status} />{variant.profileId ? <span className="field-row"><small>{profileName(variant.profileId)}</small>{variant.platform && <Network platform={variant.platform} />}</span> : <small className="muted">свободен</small>}</span></span></td>
          <td><span className="post-text">
            {variant.text ? <small className="wrap">{open === variant.id || variant.text.length <= 220 ? variant.text : `${variant.text.slice(0, 220)}…`}</small> : <small className="muted">текста ещё нет</small>}
            {open === variant.id && variant.caption && <small className="wrap"><b>Instagram:</b> {variant.caption}</small>}
            {((variant.text || '').length > 220 || variant.caption) && <button className="link" onClick={() => setOpen(open === variant.id ? null : variant.id)}>{open === variant.id ? 'Свернуть' : variant.caption ? 'Полностью и подпись Instagram' : 'Полностью'}</button>}
            {variant.error && <small className="error-text">{variant.error}</small>}
          </span></td>
          <td><EditorNotes variant={variant} /></td>
          <td className="row-actions">
            {variant.status === 'review' && <button className="ghost small" disabled={Boolean(action.busy)} onClick={() => void act(variant, { action: 'approveVariant', variantId: variant.id }, 'Вариант одобрен.')}><Check size={14} />Одобрить</button>}
            {!['outdated', 'rendering', 'writing', 'reviewing', 'archived'].includes(variant.status) && variant.text && <button className="icon-button" title="Исправить текст" aria-label="Исправить текст" onClick={() => setEditing(variant)}><Pencil size={15} /></button>}
            {!['outdated', 'writing', 'archived'].includes(variant.status) && <button className="icon-button" title="Написать заново" aria-label="Написать заново" onClick={() => void act(variant, { action: 'regenerateVariant', variantId: variant.id }, 'Вариант будет написан заново.')}><RotateCcw size={15} /></button>}
            {!['rejected', 'outdated', 'archived'].includes(variant.status) && <button className="icon-button" title="Отклонить" aria-label="Отклонить" onClick={() => void act(variant, { action: 'rejectVariant', variantId: variant.id }, 'Вариант отклонён.')}><X size={15} /></button>}
          </td>
        </tr>)}</tbody>
      </table></div> : <div className="panel-body"><p className="muted">Вариантов пока нет: они пишутся, когда материал подходит активной кампании.</p>
        <button className="ghost small" style={{ justifySelf: 'start' }} disabled={Boolean(action.busy)} onClick={() => void action.run(item.id, async () => { await send('/api/content', { action: 'ensureVariants', itemId: item.id }); await view.reload(); }, 'Варианты заказаны.')}>Написать варианты сейчас</button></div>}
    </section>) : <Empty title={filter === 'all' ? 'Вариантов пока нет' : 'Здесь пусто'} text={filter === 'all' ? 'Варианты появятся, когда материал Gudini подойдёт активной кампании.' : undefined} action={filter === 'all' ? <button className="ghost" onClick={() => ctx.go('campaigns')}>Кампании</button> : undefined} />}
    {cards && <CardsModal variant={cards} close={() => setCards(null)} />}
    {editing && <EditModal ctx={ctx} variant={editing} close={() => setEditing(null)} onSaved={() => void view.reload()} />}
  </div>;
}
