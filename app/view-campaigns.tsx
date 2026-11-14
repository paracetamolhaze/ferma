"use client";
/** «Кампании»: which Gudini materials go where; the owner's topics; and each profile's topics, voice and rhythm. */
import { useState } from 'react';
import { Check, Eye, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { STYLE_NAMES, type Style } from '@/lib/content/plan';
import { PROFILE_STYLE_NAMES, STYLE_ORDER } from '@/lib/content/rules';
import { ErrorLine, FORMAT_NAMES, KIND_NAMES, Loading, MODE_NAMES, PLATFORM_NAMES, send, Spin, useAction, useApi, words } from './content-ui';
import { Avatar, Empty, formatDate, Modal, Network, StatusPill, statusNames, type Ctx, type Profile } from './shared';

type Campaign = { id: string; name: string; status: string; mode: string; kinds: string[]; keywords: string[]; categories: string[]; profileIds: string[]; platforms: string[]; maxAccountsPerItem: number; spreadMinutes: number; since: string | null; counts: { status: string; count: number }[] };
type EditorialRow = { profileId: string; topics: string[]; style: string; formats: string[]; perDay: Record<string, number>; windows: [number, number][]; timezoneOffsetMinutes: number; minGapMinutes: number; mode: string; design: { palette?: number } | null };
type Topic = { id: string; name: string; keywords: string[] };
type Palette = { index: number; name: string; accent: string; cover: string };
type CampaignsData = { campaigns: Campaign[]; editorial: EditorialRow[]; categories: Topic[]; palettes: Palette[] };
type Assignment = { itemId: string; title: string; profile: string; platform: string; username: string | null; style: string | null; format: string | null; at: string | null; status: string; reason: string | null; urgent?: boolean };
const styleName = (style: string | null) => style ? STYLE_NAMES[style as Style] || style : '';
// UTC offsets with half hours, as the time zones of the world have them.
const OFFSETS = Array.from({ length: 53 }, (_, index) => -12 + index / 2);
const offsetName = (offset: number) => `UTC${offset < 0 ? '−' : '+'}${Math.floor(Math.abs(offset))}${Math.abs(offset) % 1 ? ':30' : ''}`;
const firstAngles = (style: string) => (STYLE_ORDER[style] || []).slice(0, 3).map(styleName).join(', ');

function CampaignForm({ ctx, campaign, topics, close, onSaved }: { ctx: Ctx; campaign: Partial<Campaign>; topics: Topic[]; close: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: campaign.name || '', mode: campaign.mode || 'manual', kinds: campaign.kinds || ['news', 'carousel'], categories: campaign.categories || [], keywords: (campaign.keywords || []).join(', '), profileIds: campaign.profileIds || [], platforms: campaign.platforms || ['threads', 'instagram'], maxAccountsPerItem: campaign.maxAccountsPerItem || 5, spreadMinutes: campaign.spreadMinutes ?? 120 });
  const action = useAction(ctx);
  const toggle = (key: 'kinds' | 'profileIds' | 'platforms' | 'categories', value: string) => setForm(current => ({ ...current, [key]: current[key].includes(value) ? current[key].filter(item => item !== value) : [...current[key], value] }));
  return <Modal title={campaign.id ? 'Кампания' : 'Новая кампания'} close={close} wide>
    <form onSubmit={event => { event.preventDefault(); void action.run('save', async () => { await send('/api/content', { action: 'saveCampaign', id: campaign.id, ...form, keywords: words(form.keywords) }); onSaved(); close(); }, campaign.id ? 'Кампания сохранена.' : 'Кампания создана на паузе: посмотрите предпросмотр и запустите её.'); }}>
      <div className="form-body form-columns">
        <div className="form-stack">
          <label>Название<input required maxLength={80} value={form.name} placeholder="Например: крипта во все аккаунты" onChange={event => setForm({ ...form, name: event.target.value })} /></label>
          <fieldset><legend>Материалы Gudini</legend><div className="targets">{[['news', 'Новости'], ['carousel', 'Карусели и видеокарусели']].map(([id, text]) => <label key={id}><input type="checkbox" checked={form.kinds.includes(id)} onChange={() => toggle('kinds', id)} />{text}</label>)}</div></fieldset>
          <fieldset><legend>Темы (ни одной: все темы)</legend><div className="targets">{topics.map(topic => <label key={topic.id}><input type="checkbox" checked={form.categories.includes(topic.name)} onChange={() => toggle('categories', topic.name)} />{topic.name}</label>)}</div></fieldset>
          <label>Только с этими словами (через запятую, можно оставить пустым)<input value={form.keywords} onChange={event => setForm({ ...form, keywords: event.target.value })} placeholder="биткоин, binance" /></label>
          <fieldset><legend>Как выходят публикации</legend><div className="choice">{Object.entries(MODE_NAMES).map(([id, text]) => <label key={id}><input type="radio" name="mode" checked={form.mode === id} onChange={() => setForm({ ...form, mode: id })} />{text}</label>)}</div></fieldset>
        </div>
        <div className="form-stack">
          <fieldset><legend>Соцсети</legend><div className="targets">{['threads', 'instagram'].map(id => <label key={id}><input type="checkbox" checked={form.platforms.includes(id)} onChange={() => toggle('platforms', id)} /><Network platform={id} />{PLATFORM_NAMES[id]}</label>)}</div></fieldset>
          <fieldset><legend>Профили (ни одного: все с подключёнными аккаунтами)</legend><div className="targets">{ctx.state.profiles.map(profile => <label key={profile.id}><input type="checkbox" checked={form.profileIds.includes(profile.id)} onChange={() => toggle('profileIds', profile.id)} />{profile.name}</label>)}</div></fieldset>
          <label className="field-row">Аккаунтов на один материал<input className="number-input" type="number" min={1} max={50} value={form.maxAccountsPerItem} onChange={event => setForm({ ...form, maxAccountsPerItem: Number(event.target.value) })} /></label>
          <label className="field-row">Между аккаунтами, минут<input className="number-input" type="number" min={0} max={1440} value={form.spreadMinutes} onChange={event => setForm({ ...form, spreadMinutes: Number(event.target.value) })} /></label>
          <small className="muted">Профиль получает материал, только если тот подходит под темы профиля. Срочная новость выходит в ближайшее свободное время каждого аккаунта, без разноса.</small>
        </div>
      </div>
      <ErrorLine text={action.error} />
      <div className="modal-footer"><button type="button" className="ghost" onClick={close}>Отмена</button><button className="primary" disabled={Boolean(action.busy) || !form.kinds.length || !form.platforms.length || !form.name.trim()}><Spin on={action.busy === 'save'}><Check size={15} /></Spin>Сохранить</button></div>
    </form>
  </Modal>;
}

function CampaignsPanel({ ctx, data, topics, reload }: { ctx: Ctx; data: CampaignsData; topics: Topic[]; reload: () => void }) {
  const action = useAction(ctx);
  const [editing, setEditing] = useState<Partial<Campaign> | null>(null);
  const [preview, setPreview] = useState<{ campaign: Campaign; data: { assignments: Assignment[]; note: string | null } | null } | null>(null);
  const names = (ids: string[]) => ids.length ? ids.map(id => ctx.state.profiles.find(profile => profile.id === id)?.name || 'удалённый профиль').join(', ') : 'все профили';
  return <section className="panel">
    <header className="panel-head"><h2>Кампании</h2><button className="primary small" onClick={() => setEditing({})}><Plus size={14} />Новая кампания</button></header>
    <ErrorLine text={action.error} />
    {data.campaigns.length ? <div className="table-scroll"><table>
      <thead><tr><th>Кампания</th><th>Как выходят</th><th>Куда</th><th>Публикации</th><th>Статус</th><th /></tr></thead>
      <tbody>{data.campaigns.map(campaign => <tr key={campaign.id}>
        <td><span className="post-text"><strong>{campaign.name}</strong><small className="wrap">{[campaign.kinds.map(kind => KIND_NAMES[kind] || kind).join(', '), campaign.categories.length ? `темы: ${campaign.categories.join(', ')}` : 'все темы', campaign.keywords.length ? `слова: ${campaign.keywords.join(', ')}` : ''].filter(Boolean).join(' · ')}</small><small className="muted wrap">до {campaign.maxAccountsPerItem} акк. на материал, между ними {campaign.spreadMinutes} мин</small></span></td>
        <td>{MODE_NAMES[campaign.mode] || campaign.mode}</td>
        <td><span className="networks">{campaign.platforms.map(platform => <Network key={platform} platform={platform} />)}</span><small className="block-note">{names(campaign.profileIds)}</small></td>
        <td>{campaign.counts.length ? <small>{campaign.counts.map(entry => `${statusNames[entry.status] || entry.status}: ${entry.count}`).join(', ')}</small> : <span className="muted">—</span>}</td>
        <td><StatusPill status={campaign.status} /></td>
        <td className="row-actions">
          <button className="ghost small" onClick={() => { setPreview({ campaign, data: null }); void send<{ assignments: Assignment[]; note: string | null }>('/api/content', { action: 'previewCampaign', id: campaign.id }).then(result => setPreview({ campaign, data: result })).catch(error => { setPreview(null); action.setError(error.message); }); }}><Eye size={14} />Предпросмотр</button>
          <button className="ghost small" disabled={Boolean(action.busy)} onClick={() => void action.run(campaign.id, async () => { await send('/api/content', { action: 'campaignStatus', id: campaign.id, status: campaign.status === 'active' ? 'paused' : 'active' }); reload(); }, campaign.status === 'active' ? 'Кампания на паузе.' : 'Кампания запущена.')}>{campaign.status === 'active' ? <><Pause size={14} />Пауза</> : <><Play size={14} />Запустить</>}</button>
          <button className="icon-button" aria-label="Изменить" title="Изменить" onClick={() => setEditing(campaign)}><Pencil size={15} /></button>
        </td>
      </tr>)}</tbody>
    </table></div> : <div className="panel-body"><p className="muted">Кампаний пока нет. Новая кампания создаётся на паузе: сначала посмотрите предпросмотр.</p></div>}
    {editing && <CampaignForm ctx={ctx} campaign={editing} topics={topics} close={() => setEditing(null)} onSaved={reload} />}
    {preview && <Modal title={`Предпросмотр: ${preview.campaign.name}`} close={() => setPreview(null)} wide><div className="form-body">
      {!preview.data ? <Loading text="Считаем…" /> : preview.data.note ? <p className="muted">{preview.data.note}</p> : preview.data.assignments.length ? <div className="table-scroll"><table>
        <thead><tr><th>Материал</th><th>Профиль</th><th>Аккаунт</th><th>Вариант</th><th>Когда</th><th>Итог</th></tr></thead>
        <tbody>{preview.data.assignments.map((row, index) => <tr key={index}>
          <td><span className="post-text"><strong>{row.title}</strong>{row.urgent && <small>срочно</small>}</span></td><td>{row.profile}</td><td><Network platform={row.platform} username={row.username} /></td>
          <td>{row.style ? `${styleName(row.style)} · ${FORMAT_NAMES[row.format || ''] || row.format}` : '—'}</td>
          <td className="nowrap">{row.at ? formatDate(row.at) : '—'}</td>
          <td>{row.reason ? <small className="muted">{row.reason}</small> : <small>{statusNames[row.status] || row.status}</small>}</td>
        </tr>)}</tbody>
      </table></div> : <p className="muted">Подходящих материалов и аккаунтов сейчас нет. Проверьте темы кампании и профилей и подключение аккаунтов.</p>}
      <p className="muted">Предпросмотр ничего не создаёт и не публикует. Варианты показаны любые, а выйдут только проверенные редактором.</p>
    </div></Modal>}
  </section>;
}

function TopicsPanel({ ctx, topics, reload }: { ctx: Ctx; topics: Topic[]; reload: () => void }) {
  const action = useAction(ctx);
  const [editing, setEditing] = useState<{ id?: string; name: string; keywords: string } | null>(null);
  return <section className="panel">
    <header className="panel-head"><h2>Темы</h2><button className="ghost small" onClick={() => setEditing({ name: '', keywords: '' })}><Plus size={14} />Новая тема</button></header>
    <ErrorLine text={action.error} />
    <ul className="plain-list">{topics.map(topic => <li key={topic.id}>
      <span className="post-text"><strong>{topic.name}</strong><small className="muted">{topic.keywords.length ? topic.keywords.join(', ') : 'без слов: сюда попадает то, что не подошло к другим темам'}</small></span>
      <span className="row-actions">
        <button className="icon-button" aria-label={`Изменить тему ${topic.name}`} title="Изменить" onClick={() => setEditing({ id: topic.id, name: topic.name, keywords: topic.keywords.join(', ') })}><Pencil size={15} /></button>
        <button className="icon-button" aria-label={`Удалить тему ${topic.name}`} title="Удалить" disabled={Boolean(action.busy)} onClick={() => { if (confirm(`Удалить тему «${topic.name}»? Кампании и профили с этой темой перестанут её получать.`)) void action.run(topic.id, async () => { await send('/api/content', { action: 'deleteCategory', id: topic.id }); reload(); }, 'Тема удалена.'); }}><Trash2 size={15} /></button>
      </span>
    </li>)}</ul>
    <div className="panel-note"><small className="muted">Каждый новый материал Gudini раскладывает по темам ИИ (до 20 материалов за одно обращение к GPT-мосту). Если мост недоступен, решают слова темы.</small></div>
    {editing && <Modal title={editing.id ? 'Тема' : 'Новая тема'} close={() => setEditing(null)}>
      <form onSubmit={event => { event.preventDefault(); void action.run('save', async () => { await send('/api/content', { action: 'saveCategory', id: editing.id, name: editing.name, keywords: words(editing.keywords) }); setEditing(null); reload(); }, 'Тема сохранена.'); }}>
        <div className="form-body form-stack">
          <label>Название<input required maxLength={40} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
          <label>Слова-подсказки (через запятую)<textarea rows={3} value={editing.keywords} placeholder="биткоин, binance, токен" onChange={event => setEditing({ ...editing, keywords: event.target.value })} /></label>
          <small className="muted">Слово считается найденным по началу: «биткоин» находит «биткоина» и «биткоину».</small>
          <ErrorLine text={action.error} />
        </div>
        <div className="modal-footer"><button type="button" className="ghost" onClick={() => setEditing(null)}>Отмена</button><button className="primary" disabled={Boolean(action.busy) || !editing.name.trim()}><Spin on={action.busy === 'save'}><Check size={15} /></Spin>Сохранить</button></div>
      </form>
    </Modal>}
  </section>;
}

function EditorialModal({ ctx, profile, row, topics, palettes, close, onSaved }: { ctx: Ctx; profile: Profile; row: EditorialRow | undefined; topics: Topic[]; palettes: Palette[]; close: () => void; onSaved: () => void }) {
  const known = new Set(topics.map(topic => topic.name));
  const [form, setForm] = useState({
    categories: (row?.topics || []).filter(topic => known.has(topic)), extra: (row?.topics || []).filter(topic => !known.has(topic)).join(', '),
    style: row?.style || 'neutral', formats: row?.formats || ['text', 'image', 'carousel'], threads: row?.perDay.threads ?? 2, instagram: row?.perDay.instagram ?? 1,
    from: row?.windows[0]?.[0] ?? 9, to: row?.windows[0]?.[1] ?? 22, offset: (row?.timezoneOffsetMinutes ?? 300) / 60, gap: row?.minGapMinutes ?? 90, mode: row?.mode || 'manual',
    palette: Number.isInteger(row?.design?.palette) ? row!.design!.palette! : -1,
  });
  const action = useAction(ctx);
  const toggle = (key: 'categories' | 'formats', value: string) => setForm(current => ({ ...current, [key]: current[key].includes(value) ? current[key].filter(item => item !== value) : [...current[key], value] }));
  return <Modal title={`${profile.name}: что и как публикует`} close={close} wide>
    <form onSubmit={event => { event.preventDefault(); void action.run('save', async () => {
      await send('/api/content', { action: 'saveEditorial', profileId: profile.id, topics: [...form.categories, ...words(form.extra)], style: form.style, formats: form.formats, perDay: { threads: form.threads, instagram: form.instagram }, windows: [[form.from, form.to]], timezoneOffsetMinutes: Math.round(form.offset * 60), minGapMinutes: form.gap, mode: form.mode, design: form.palette >= 0 ? { palette: form.palette } : null });
      onSaved(); close();
    }, `${profile.name}: сохранено.`); }}>
      <div className="form-body form-columns">
        <div className="form-stack">
          <fieldset><legend>Темы (ни одной: берёт всё)</legend><div className="targets">{topics.map(topic => <label key={topic.id}><input type="checkbox" checked={form.categories.includes(topic.name)} onChange={() => toggle('categories', topic.name)} />{topic.name}</label>)}</div></fieldset>
          <label>Или слова (через запятую)<input value={form.extra} placeholder="например: solana, мемкоин" onChange={event => setForm({ ...form, extra: event.target.value })} /></label>
          <label>Подача<select value={form.style} onChange={event => setForm({ ...form, style: event.target.value })}>{Object.entries(PROFILE_STYLE_NAMES).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>
          <small className="muted">Первыми профиль берёт варианты: {firstAngles(form.style)}. Среди них — с лучшей оценкой ИИ-редактора.</small>
          <fieldset><legend>Форматы в Threads</legend><div className="targets">{['text', 'image', 'carousel'].map(id => <label key={id}><input type="checkbox" checked={form.formats.includes(id)} onChange={() => toggle('formats', id)} />{FORMAT_NAMES[id]}</label>)}</div></fieldset>
          <small className="muted">В Instagram выходят только карусели Gudini.</small>
          {!form.formats.length && <small className="error-text">Отметьте хотя бы один формат для Threads.</small>}
        </div>
        <div className="form-stack">
          <fieldset><legend>Сколько в день</legend><div className="targets">
            <label className="field-row"><Network platform="threads" />Threads<input className="number-input" type="number" min={0} max={20} value={form.threads} onChange={event => setForm({ ...form, threads: Number(event.target.value) })} /></label>
            <label className="field-row"><Network platform="instagram" />Instagram<input className="number-input" type="number" min={0} max={20} value={form.instagram} onChange={event => setForm({ ...form, instagram: Number(event.target.value) })} /></label>
          </div></fieldset>
          <fieldset><legend>Когда</legend><div className="targets">
            <label className="field-row">с<input className="number-input" type="number" min={0} max={23} value={form.from} onChange={event => setForm({ ...form, from: Number(event.target.value) })} />до<input className="number-input" type="number" min={1} max={24} value={form.to} onChange={event => setForm({ ...form, to: Number(event.target.value) })} />часов</label>
            <label className="field-row">часовой пояс<select className="compact-select" value={form.offset} onChange={event => setForm({ ...form, offset: Number(event.target.value) })}>{OFFSETS.map(offset => <option key={offset} value={offset}>{offsetName(offset)}</option>)}</select></label>
            <label className="field-row">не чаще раза в<input className="number-input" type="number" min={15} max={1440} value={form.gap} onChange={event => setForm({ ...form, gap: Number(event.target.value) })} />мин</label>
          </div></fieldset>
          <label>Как выходят публикации<select value={form.mode} onChange={event => setForm({ ...form, mode: event.target.value })}>{Object.entries(MODE_NAMES).map(([id, text]) => <option key={id} value={id}>{text}</option>)}</select></label>
          <small className="muted">Из режима кампании и режима профиля действует более строгий.</small>
          <fieldset><legend>Цвет карточек Gudini</legend><div className="palette-choice">
            <label><input type="radio" name="palette" checked={form.palette < 0} onChange={() => setForm({ ...form, palette: -1 })} /><span className="swatch auto" />Сам по порядку</label>
            {palettes.map(palette => <label key={palette.index}><input type="radio" name="palette" checked={form.palette === palette.index} onChange={() => setForm({ ...form, palette: palette.index })} /><span className="swatch" style={{ background: palette.accent }} />{palette.name}</label>)}
          </div></fieldset>
          {!palettes.length && <small className="muted">Цвета появятся, когда из Gudini придёт карусель, которую можно перерисовать.</small>}
        </div>
      </div>
      <ErrorLine text={action.error} />
      <div className="modal-footer"><button type="button" className="ghost" onClick={close}>Отмена</button><button className="primary" disabled={Boolean(action.busy) || !form.formats.length}><Spin on={action.busy === 'save'}><Check size={15} /></Spin>Сохранить</button></div>
    </form>
  </Modal>;
}

function ProfilesPanel({ ctx, data, reload }: { ctx: Ctx; data: CampaignsData; reload: () => void }) {
  const [editing, setEditing] = useState<Profile | null>(null);
  const known = new Set(data.categories.map(topic => topic.name));
  return <section className="panel">
    <header className="panel-head"><h2>Профили</h2></header>
    {ctx.state.profiles.length ? <ul className="plain-list">{ctx.state.profiles.map(profile => {
      const row = data.editorial.find(entry => entry.profileId === profile.id);
      const palette = data.palettes.find(entry => entry.index === row?.design?.palette);
      const topics = row?.topics || [];
      return <li key={profile.id} className="clickable" onClick={() => setEditing(profile)}>
        <span className="who"><Avatar profile={profile} /><strong>{profile.name}</strong></span>
        <span className="post-text grow"><small>{topics.length ? topics.map(topic => known.has(topic) ? topic : `«${topic}»`).join(', ') : 'все темы'} · {PROFILE_STYLE_NAMES[row?.style || 'neutral']}</small>
          <small className="muted">Threads {row?.perDay.threads ?? 2} в день, Instagram {row?.perDay.instagram ?? 1}; с {row?.windows[0]?.[0] ?? 9} до {row?.windows[0]?.[1] ?? 22} ч; {(MODE_NAMES[row?.mode || 'manual'] || '').toLowerCase()}</small></span>
        <span className="field-row nowrap">{palette ? <><span className="swatch" style={{ background: palette.accent }} /><small>{palette.name}</small></> : <small className="muted">цвет по порядку</small>}</span>
        <button className="ghost small" onClick={event => { event.stopPropagation(); setEditing(profile); }}><Pencil size={14} />Настроить</button>
      </li>;
    })}</ul> : <div className="panel-body"><Empty title="Профилей пока нет" action={<button className="primary" onClick={ctx.addProfile}><Plus size={16} />Новый профиль</button>} /></div>}
    {editing && <EditorialModal ctx={ctx} profile={editing} row={data.editorial.find(entry => entry.profileId === editing.id)} topics={data.categories} palettes={data.palettes} close={() => setEditing(null)} onSaved={reload} />}
  </section>;
}

export function CampaignsView({ ctx }: { ctx: Ctx }) {
  const view = useApi<CampaignsData>('/api/content?view=campaigns', 30000);
  if (view.loading && !view.data) return <Loading />;
  if (!view.data) return <ErrorLine text={view.error} />;
  const reload = () => void view.reload();
  return <div className="stack">
    <ErrorLine text={view.error} />
    <CampaignsPanel ctx={ctx} data={view.data} topics={view.data.categories} reload={reload} />
    <ProfilesPanel ctx={ctx} data={view.data} reload={reload} />
    <TopicsPanel ctx={ctx} topics={view.data.categories} reload={reload} />
  </div>;
}
