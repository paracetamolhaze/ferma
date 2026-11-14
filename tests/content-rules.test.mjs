import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFacts, similarity, simhash, nearDuplicate, numbersIn, scoreVariant, relate, idfOf, mentions } from '../lib/content/text-quality.ts';
import { planVariants, originalCards, coverAsset, paletteFor, visible } from '../lib/content/plan.ts';
import { topicScore, pickVariant, nextSlot, effectiveMode, fitScore, DEFAULT_EDITORIAL, STYLE_ORDER, PROFILE_STYLE_NAMES } from '../lib/content/rules.ts';
import { metricsOf, median, proposalsFor } from '../lib/content/analytics-rules.ts';
import { parseVariants } from '../docker/content.mjs';

const source = {
  text: 'Совет директоров Банка России 24 октября снизил ключевую ставку до 16,5%. Это второе снижение подряд. Эльвира Набиуллина сказала: «мы видим замедление инфляции». По данным Интерфакс, решение ждали 30 из 32 аналитиков.',
  links: ['https://www.interfax.ru/business/1'],
};

test('facts: numbers, dates, names, quotes and links must come from the material', () => {
  assert.deepEqual([...numbersIn('ставка 16,5% и 16.5 и 1 000 рублей')].sort(), ['1000', '16.5'].sort());
  assert.equal(checkFacts(source, 'ЦБ снизил ставку до 16,5% 24 октября: это второе снижение подряд.').ok, true, 'rephrasing is fine');
  const invented = checkFacts(source, 'Банк России снизил ставку до 15% 25 ноября.');
  assert.equal(invented.ok, false);
  assert.deepEqual(invented.problems.map(item => item.kind).sort(), ['month', 'number', 'number'].sort());
  assert.equal(checkFacts(source, 'Решение поддержал Герман Греф.').ok, false, 'a new name');
  assert.equal(checkFacts(source, 'Набиуллина: «мы видим замедление инфляции».').ok, true, 'exact quote');
  assert.equal(checkFacts(source, 'Набиуллина: «инфляция побеждена окончательно и навсегда».').ok, false, 'invented quote');
  assert.equal(checkFacts(source, 'Подробнее: https://www.interfax.ru/business/1').ok, true);
  assert.equal(checkFacts(source, 'Подробнее: https://evil.example/x').ok, false, 'foreign link');
  assert.equal(checkFacts(source, '1. Ставка снижена.\n2. Второе снижение подряд.').ok, true, 'list numbers are not facts');
});

test('similarity: near copies are caught, real rewrites pass', () => {
  const copy = source.text.replace('снизил', 'понизил');
  assert.ok(similarity(source.text, copy) > 0.6, `copy ${similarity(source.text, copy)}`);
  const rewrite = 'Что случилось со ставкой? ЦБ второй раз подряд её понизил, теперь 16,5%. Решения ждали 30 из 32 опрошенных аналитиков.';
  assert.ok(similarity(source.text, rewrite) < 0.3, `rewrite ${similarity(source.text, rewrite)}`);
  assert.ok(nearDuplicate(simhash(source.text), simhash(copy), 12), 'simhash of a near copy is close');
  assert.ok(!nearDuplicate(simhash(source.text), simhash('Совсем другая история про погоду в Москве и снег на выходных, без ставок и банков вообще.')));
  const score = scoreVariant(source, rewrite, [rewrite], 480);
  assert.ok(score.problems.some(problem => problem.includes('похож на другой вариант')), 'a sibling with the same text is refused');
});

const carousel = {
  kind: 'carousel', title: 'USDT со скидкой заморозят', sources: [{ url: 'https://decrypt.co/1', title: null, publisher: 'Decrypt', date: null, note: null }],
  cards: [
    { index: 0, role: 'cover', kicker: 'СРОЧНО', title: 'USDT со скидкой заморозят?', body: 'Проверь, у кого брал', bullets: [], asset: 'slides/s0.jpg', image: 'sid/cover.png' },
    { index: 1, role: 'content', kicker: 'crypto.news', title: 'Не заводи USDT со скидкой', body: 'Сооснователь Binance He Yi написала пост.', bullets: ['ПОСТ: 8 ноября'], asset: 'slides/s1.jpg', image: 'sid/shot-1.png' },
    { index: 2, role: 'content', kicker: 'PANews', title: 'В списке Мьянма и Камбоджа', body: 'Деньги от бизнеса в Мьянме.', bullets: [], asset: 'slides/s2.jpg', image: null },
    { index: 3, role: 'final', kicker: '', title: 'Перешли тому, кто берёт USDT', body: 'Пиши в комментариях.', bullets: [], asset: 'slides/s3.jpg', image: null },
  ],
  assets: [
    ...['s0', 's1', 's2', 's3'].map((name, card) => ({ id: `slides/${name}.jpg`, role: 'render', card, contentType: 'image/jpeg' })),
    { id: 'sid/cover.png', role: 'cover_art', card: 0, contentType: 'image/png' }, { id: 'sid/shot-1.png', role: 'screenshot', card: 1, contentType: 'image/png' },
  ],
};

const editable = { style: 'investigation', palette: 0, palettes: [], limits: { coverLine: 12 }, content: { cover: { pill: 'СРОЧНО', title: ['USDT'], accentLine: '24,35 МЛН', hook: 'Листай' }, steps: [], final: { black: [], accent: [], cards: [], body: '' }, caption: '' } };

test('variant plan: pictures are always from Gudini, honest maximum, Instagram-ready formats only where they exist', () => {
  const redrawable = planVariants({ ...carousel, editable }, 5);
  assert.deepEqual(redrawable.map(entry => entry.layout), ['original', 'gudini', 'gudini', 'gudini', 'none']);
  assert.equal(new Set(redrawable.map(entry => `${entry.style}/${entry.layout}`)).size, 5, 'no two versions alike');
  assert.equal(planVariants({ ...carousel, editable }, 200).length, 8, 'never more than the pool of really different versions');
  const fixed = planVariants(carousel, 5);
  assert.deepEqual(fixed.map(entry => entry.layout), ['original', 'none', 'none', 'none', 'none'], 'a carousel Gudini can not redraw goes out once with its cards');
  const news = planVariants({ kind: 'news', cards: [carousel.cards[0]], assets: [{ id: 'cover.jpg', role: 'cover', card: 0, contentType: 'image/jpeg' }] }, 5);
  assert.deepEqual(news.map(entry => entry.layout), ['none', 'cover', 'none', 'none', 'none']);
  assert.ok(!planVariants({ kind: 'carousel', cards: carousel.cards, assets: [] }, 8).some(entry => entry.layout === 'original'));
  assert.ok(planVariants(carousel, 8).every(entry => !['photo', 'frame', 'type', 'summary', 'compact'].includes(entry.layout)), 'FERMA draws no cards of its own');
});

test('Gudini pictures: original cards in order, the news cover, a colour per account, letters counted as Gudini counts', () => {
  const stored = new Set(carousel.assets.map(asset => asset.id));
  assert.deepEqual(originalCards(carousel, stored), ['slides/s0.jpg', 'slides/s1.jpg', 'slides/s2.jpg', 'slides/s3.jpg']);
  assert.equal(coverAsset({ assets: [{ id: 'cover.jpg', role: 'cover' }] }, new Set(['cover.jpg'])), 'cover.jpg');
  assert.equal(paletteFor(null, 0, 3, 7), 1, 'the first profile gets the second colour');
  assert.equal(paletteFor(null, 2, 3, 7), 4, 'a redrawn version never keeps the original colour');
  assert.equal(paletteFor(5, 0, 0, 7), 5, 'the colour chosen in the profile wins');
  assert.equal(paletteFor(3, 0, 3, 7), 4);
  assert.equal(visible('**8 ноября** He Yi'), 14, 'bold marks are not letters');
});

test('distribution rules: topics, formats per platform, styles, modes', () => {
  const item = { title: 'Биткоин упал ниже $72 000', topic: null, category: null, caption: '', text: 'Ликвидации на Binance', cards: [] };
  assert.equal(topicScore([], item), 1, 'no topics = takes everything');
  assert.equal(topicScore(['биткоин'], item), 1);
  assert.equal(topicScore(['биткоина'], item), 1, 'Russian endings do not matter');
  assert.equal(topicScore(['кино', 'погода'], item), 0);
  const variants = [
    { id: 'a', style: 'brief', format: 'text', status: 'ready', profileId: null },
    { id: 'b', style: 'explainer', format: 'carousel', status: 'written', profileId: null },
    { id: 'c', style: 'qa', format: 'image', status: 'ready', profileId: null },
    { id: 'd', style: 'why_matters', format: 'carousel', status: 'rejected', profileId: null },
  ];
  assert.equal(pickVariant(variants, 'instagram', DEFAULT_EDITORIAL, 'carousel').id, 'b', 'Instagram gets carousels');
  assert.equal(pickVariant(variants, 'threads', DEFAULT_EDITORIAL, 'news').id, 'a', 'Threads reads news as text');
  assert.equal(pickVariant(variants.filter(entry => entry.format !== 'carousel'), 'instagram', DEFAULT_EDITORIAL, 'news'), null, 'a 9:16 news cover never goes to the Instagram feed');
  assert.equal(pickVariant(variants, 'instagram', { ...DEFAULT_EDITORIAL, formats: ['text'] }, 'news').id, 'b', 'the profile\'s Threads formats do not switch Instagram off');
  assert.equal(pickVariant(variants, 'threads', { ...DEFAULT_EDITORIAL, formats: ['image'] }, 'news').id, 'c', 'the profile can limit formats');
  assert.equal(pickVariant(variants.map(entry => ({ ...entry, profileId: 'taken' })), 'threads', DEFAULT_EDITORIAL, 'news'), null, 'a version goes to one account only');
  assert.equal(effectiveMode('auto', 'manual'), 'manual');
  assert.equal(effectiveMode('draft', 'auto'), 'draft');
});

test('schedule: own hours and time zone, daily number, gap, and the same material spread over accounts', () => {
  const now = Date.parse('2026-11-14T03:00:00Z'); // 08:00 at UTC+5
  const editorial = { perDay: { threads: 2 }, windows: [[9, 22]], timezoneOffsetMinutes: 300, minGapMinutes: 90 };
  const local = ms => new Date(ms + 300 * 60_000).toISOString().slice(11, 16);
  const first = nextSlot({ nowMs: now, editorial, platform: 'threads', taken: [], sameItem: [], spreadMinutes: 120 });
  assert.equal(local(first), '09:00', 'not before the profile wakes up');
  const second = nextSlot({ nowMs: now, editorial, platform: 'threads', taken: [first], sameItem: [], spreadMinutes: 0 });
  assert.equal(local(second), '10:30', 'minimum gap');
  const third = nextSlot({ nowMs: now, editorial, platform: 'threads', taken: [first, second], sameItem: [], spreadMinutes: 0 });
  assert.ok(third - now > 86_400_000 - 3 * 3600_000 && local(third) === '09:00', 'third post moves to the next day');
  const otherAccount = nextSlot({ nowMs: now, editorial, platform: 'threads', taken: [], sameItem: [first], spreadMinutes: 120 });
  assert.equal(local(otherAccount), '11:00', 'the same material is not posted everywhere at once');
  assert.equal(nextSlot({ nowMs: now, editorial: { ...editorial, perDay: { threads: 0 } }, platform: 'threads', taken: [], sameItem: [], spreadMinutes: 0 }), null);
});

test('writer answer: JSON is read from a fenced reply, junk entries dropped', () => {
  const text = '```json\n{"variants":[{"slot":0,"text":"a"},{"slot":"x"},{"slot":2,"headline":"h","caption":"c"}]}\n```';
  assert.deepEqual(parseVariants(text), [{ slot: 0, headline: null, text: 'a', caption: null }, { slot: 2, headline: 'h', text: null, caption: 'c' }]);
  assert.throws(() => parseVariants('{"nothing":1}'));
});

test('editor and topics: picked by rating among passed versions only; topics by category or by words', () => {
  const versions = [
    { id: 'low', style: 'explainer', format: 'text', status: 'ready', profileId: null, score: 81 },
    { id: 'high', style: 'qa', format: 'text', status: 'ready', profileId: null, score: 94 },
    { id: 'waiting', style: 'brief', format: 'text', status: 'reviewing', profileId: null, score: null },
    { id: 'owner', style: 'brief', format: 'text', status: 'review', profileId: null, score: 69 },
  ];
  assert.equal(pickVariant(versions, 'threads', DEFAULT_EDITORIAL, 'news').id, 'high', 'the editor\'s rating comes before the style');
  assert.equal(pickVariant(versions.filter(entry => entry.id !== 'high' && entry.id !== 'low'), 'threads', DEFAULT_EDITORIAL, 'news'), null, 'nothing unchecked or waiting for the owner goes out');
  const known = new Set(['Криптовалюты', 'Политика']);
  const item = { title: 'Tether заморозила USDT', topic: null, category: null, caption: '', text: 'Заморозка на пяти адресах', cards: [] };
  assert.equal(fitScore(['Криптовалюты'], known, ['Криптовалюты'], item), 1, 'a category decides by the classifier\'s result');
  assert.equal(fitScore(['Политика'], known, ['Криптовалюты'], item), 0);
  assert.equal(fitScore(['заморозка'], known, [], item), 1, 'a plain word is searched in the text');
  assert.equal(fitScore([], known, [], item), 1, 'no topics: takes everything');
});

test('the same story: a retelling is caught by meaning, the same picture alone does not join two stories', () => {
  const a = { title: 'Банк России снизил ставку до 16,5%', text: 'Совет директоров Банка России 24 октября снизил ключевую ставку до 16,5%. Это второе снижение подряд.' };
  const retold = { title: 'Ставка снова ниже: теперь 16,5%', text: 'Банк России 24 октября опустил ключевую ставку до 16,5% - уже второй раз подряд снизил её совет директоров.' };
  const other = { title: 'Биткоин упал ниже $72 000', text: 'Курс биткоина опустился ниже 72 000 долларов, на Binance прошли ликвидации.' };
  const idf = idfOf([a, retold, other].map(entry => `${entry.title} ${entry.text}`));
  assert.ok(['paraphrase', 'same_story'].includes(relate(a, retold, idf).kind), JSON.stringify(relate(a, retold, idf)));
  assert.equal(relate({ ...a, dhash: 'f0f0f0f0f0f0f0f0' }, { ...other, dhash: 'f0f0f0f0f0f0f0f0' }, idf).kind, 'independent', 'one stock picture, two stories');
});

test('analytics: only returned numbers count; a recommendation needs 5+ posts a side and 30% difference', () => {
  assert.deepEqual(metricsOf(null), { views: null, interactions: null, rate: null }, 'no insights: no data, not zero');
  assert.deepEqual(metricsOf({ views: 200, likes: 6, replies: 4 }), { views: 200, interactions: 10, rate: 0.05 });
  assert.equal(metricsOf({ reach: 50, likes: 3 }).rate, null, 'reach is not views');
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
  let n = 0;
  const post = (style, format, views, likes) => ({ id: String(n++), platform: 'threads', profileId: 'p', profile: 'P', username: 'u', style, format, layout: null, hour: 10, categories: [], publishedAt: '2026-11-01', ...metricsOf({ views, likes }) });
  const editorial = { style: 'neutral', formats: ['text', 'image', 'carousel'] };
  const options = { styleOrder: STYLE_ORDER, profileStyleNames: PROFILE_STYLE_NAMES };
  // «neutral» takes «explainer» first; Q&A versions got far more reactions.
  const posts = [...Array.from({ length: 5 }, () => post('explainer', 'text', 1000, 20)), ...Array.from({ length: 5 }, () => post('qa', 'text', 1000, 40))];
  const [style] = proposalsFor('p', posts, editorial, options);
  assert.equal(style.kind, 'style');
  assert.deepEqual(style.change, { style: 'casual' }, 'the profile style that puts Q&A first');
  assert.match(style.reason, /4,0%.*5 постов.*2,0%/);
  assert.deepEqual(proposalsFor('p', posts.slice(1), editorial, options), [], 'four posts on one side: no conclusion');
  const close = [...Array.from({ length: 5 }, () => post('explainer', 'text', 1000, 30)), ...Array.from({ length: 5 }, () => post('qa', 'text', 1000, 36))];
  assert.deepEqual(proposalsFor('p', close, editorial, options), [], '20% better is not enough');
  const formats = [...Array.from({ length: 5 }, () => post('explainer', 'text', 1000, 30)), ...Array.from({ length: 5 }, () => post('explainer', 'image', 1000, 10))];
  const [format] = proposalsFor('p', formats, editorial, options);
  assert.deepEqual([format.kind, format.change], ['format:image', { formats: ['text', 'carousel'] }]);
});

test('topic words are found in any form, short words included, and only as the start of a word', () => {
  const text = 'Центробанк поднял ставку, рубль ослаб. Нейросети и игры: новые релизы. Кредиты дорожают.';
  for (const word of ['ставка', 'рубль', 'нейросеть', 'игра', 'кредит', 'центробанк']) assert.ok(mentions(text, word), word);
  assert.ok(!mentions(text, 'нефть'));
  assert.ok(!mentions('Он сказал правду', 'казак'), 'not in the middle of a word');
  assert.ok(mentions('Искусственный интеллект пишет код', 'искусственный интеллект'), 'every word of a phrase');
  assert.ok(!mentions('Искусственный мех', 'искусственный интеллект'));
  assert.ok(mentions('Курс BTC упал', 'btc'));
});
