"use client";
/** Settings of the FERMA 2.0 pipeline: the public address, versions, the AI editor, freshness and storage. */
import { useState } from 'react';
import { Check } from 'lucide-react';
import { ErrorLine, Loading, send, Spin, useAction, useApi } from './content-ui';
import type { Ctx } from './shared';

type Settings = { publicBaseUrl: string | null; autopublish: number; variantsPerItem: number; dailyWriterCalls: number; fetchVideo: number; qualityThreshold: number; maxAgeHours: number; retentionDays: number; reviewEnabled: number };

function Form({ ctx, settings, onSaved }: { ctx: Ctx; settings: Settings; onSaved: () => void }) {
  const [form, setForm] = useState({ publicBaseUrl: settings.publicBaseUrl || '', variantsPerItem: settings.variantsPerItem, dailyWriterCalls: settings.dailyWriterCalls, reviewEnabled: Boolean(settings.reviewEnabled), qualityThreshold: settings.qualityThreshold, maxAgeHours: settings.maxAgeHours, retentionDays: settings.retentionDays });
  const action = useAction(ctx);
  const number = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: Number(event.target.value) });
  return <form className="form-stack" onSubmit={event => { event.preventDefault(); void action.run('save', async () => { await send('/api/content', { action: 'settings', ...form, publicBaseUrl: form.publicBaseUrl.trim() || null }); onSaved(); }, 'Настройки сохранены.'); }}>
    <label>Публичный адрес FERMA<input value={form.publicBaseUrl} placeholder="https://ваш-домен/ferma" onChange={event => setForm({ ...form, publicBaseUrl: event.target.value })} /></label>
    <small className="muted">Адрес через Caddy, ведущий на порт 3102 этого компьютера. По нему Meta забирает картинки по одноразовым подписанным ссылкам и возвращает вас после входа. Остальное в FERMA снаружи недоступно.</small>
    <label className="field-row">Вариантов на материал<input className="number-input" type="number" min={1} max={8} value={form.variantsPerItem} onChange={number('variantsPerItem')} /></label>
    <label className="field-row">Обращений к GPT-мосту в день<input className="number-input" type="number" min={1} max={500} value={form.dailyWriterCalls} onChange={number('dailyWriterCalls')} /></label>
    <small className="muted">Одно обращение пишет все варианты материала сразу.</small>
    <label className="switch"><input type="checkbox" checked={form.reviewEnabled} onChange={event => setForm({ ...form, reviewEnabled: event.target.checked })} />ИИ-редактор читает каждый вариант</label>
    <label className="field-row">Проходной балл редактора<input className="number-input" type="number" min={50} max={100} disabled={!form.reviewEnabled} value={form.qualityThreshold} onChange={number('qualityThreshold')} />из 100</label>
    <small className="muted">Ниже балла вариант ждёт вашей проверки. Утверждение, которого нет в источниках Gudini, всегда отправляет вариант к вам, противоречие источникам — на переписывание.</small>
    <label className="field-row">Новость считается свежей<input className="number-input" type="number" min={1} max={720} value={form.maxAgeHours} onChange={number('maxAgeHours')} />часов</label>
    <small className="muted">Материал старше этого срока не раздаётся, а запланированная публикация снимается с причиной.</small>
    <label className="field-row">Хранить карточки FERMA<input className="number-input" type="number" min={3} max={365} value={form.retentionDays} onChange={number('retentionDays')} />дней</label>
    <small className="muted">После срока удаляются только карточки, нарисованные для FERMA и уже не нужные. Файлы Gudini не удаляются никогда.</small>
    <ErrorLine text={action.error} />
    <div><button className="primary" disabled={Boolean(action.busy)}><Spin on={action.busy === 'save'}><Check size={15} /></Spin>Сохранить</button></div>
  </form>;
}

export function ContentSettings({ ctx }: { ctx: Ctx }) {
  const view = useApi<{ settings: Settings }>('/api/content?view=engine');
  return <section className="panel">
    <header className="panel-head"><h2>Публикации FERMA</h2></header>
    <div className="panel-body">{view.data ? <Form key={JSON.stringify(view.data.settings)} ctx={ctx} settings={view.data.settings} onSaved={() => void view.reload()} /> : view.error ? <ErrorLine text={view.error} /> : <Loading />}</div>
  </section>;
}
