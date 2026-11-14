/**
 * Checks for editorial variants: facts must come from the source, versions must really differ.
 * Pure functions, no I/O: used by the variant engine in the app and by tests.
 */

export type FactProblem = { kind: 'number' | 'month' | 'name' | 'quote' | 'link'; value: string };
export type FactCheck = { ok: boolean; problems: FactProblem[] };

const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const MONTH_WORD = /^(январ[ья]|феврал[ья]|марта?|апрел[ья]|ма[йя]|июн[ья]|июл[ья]|августа?|сентябр[ья]|октябр[ья]|ноябр[ья]|декабр[ья])$/i;
/** Orders of magnitude in words; a form ending with "." must match the whole word (abbreviations). */
const MAGNITUDES = [['тысяч', 'тыс.'], ['миллион', 'млн.'], ['миллиард', 'млрд.'], ['триллион', 'трлн.']];
// Words that start sentences and questions; never treated as names.
const COMMON = new Set(['это', 'что', 'как', 'кто', 'где', 'когда', 'почему', 'зачем', 'чем', 'какие', 'какой', 'какая', 'какое', 'сколько', 'теперь', 'итог', 'итоги', 'главное', 'коротко', 'вопрос', 'ответ', 'важно', 'итак', 'но', 'и', 'а', 'или', 'если', 'так', 'там', 'тут', 'здесь', 'уже', 'ещё', 'еще', 'при', 'по', 'на', 'в', 'с', 'для', 'после', 'до', 'из', 'от', 'за', 'о', 'об', 'новость', 'новости', 'что произошло', 'последствия', 'источник', 'источники', 'подробности', 'кратко', 'контекст', 'суть', 'почему это важно']);

export const normalizeText = (text: string) => text.toLowerCase().replace(/ё/g, 'е').replace(/[  ]/g, ' ');
/** "16,5" "16.5" "1 000" -> "16.5" "1000": the same number written in different ways compares equal. */
export function numbersIn(text: string) {
  const found = new Set<string>();
  const cleaned = text.replace(/^\s*\d{1,2}[.)]\s/gm, ' ').replace(/https?:\/\/\S+/g, ' ');
  for (const match of cleaned.matchAll(/\d+(?:[   ]\d{3})*(?:[.,]\d+)?/g)) {
    const value = match[0].replace(/[   ]/g, '').replace(',', '.');
    found.add(value.replace(/^0+(?=\d)/, '').replace(/\.0+$/, ''));
  }
  return found;
}
const stem = (word: string) => normalizeText(word).replace(/[^a-zа-я0-9-]/g, '').slice(0, 5);
const wordsOf = (text: string) => normalizeText(text).match(/[a-zа-я0-9][a-zа-я0-9-]*/g) || [];
/**
 * Capitalised words that are not the first word of a sentence: names of people, places, organisations.
 * A line set in capitals (Gudini's covers and finals) has no case to tell names by: there only Latin words count
 * (brands, tickers), Russian words in capitals are ordinary words.
 */
export function namesIn(text: string) {
  const names = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?…:])\s+|\n+/)) {
    const tokens = sentence.match(/[A-Za-zА-ЯЁа-яё][A-Za-zА-ЯЁа-яё-]*/g) || [];
    const letters = sentence.replace(/[^A-Za-zА-ЯЁа-яё]/g, '');
    const capsLine = letters.length >= 4 && letters.replace(/[^A-ZА-ЯЁ]/g, '').length / letters.length > 0.6;
    if (capsLine) {
      for (const token of tokens) if (/^[A-Z][A-Z0-9-]*$/i.test(token) && /[A-Z]/.test(token) && !COMMON.has(normalizeText(token))) names.add(token);
      continue;
    }
    tokens.forEach((token, index) => {
      const upper = token === token.toUpperCase() && token.length >= 2 && /[A-ZА-ЯЁ]/.test(token);
      if (index === 0 && !upper) return;
      if (!/^[A-ZА-ЯЁ]/.test(token)) return;
      if (COMMON.has(normalizeText(token))) return;
      names.add(token);
    });
  }
  return names;
}
export function quotesIn(text: string) {
  const quotes: string[] = [];
  for (const match of text.matchAll(/[«“"]([^«»“”"]{12,}?)[»”"]/g)) {
    if (match[1].trim().split(/\s+/).length >= 3) quotes.push(match[1].trim());
  }
  return quotes;
}
export const linksIn = (text: string) => new Set((text.match(/https?:\/\/[^\s)»"]+/g) || []).map(link => link.replace(/[.,;]+$/, '')));

/**
 * Every number, date, name, quotation and link in a variant must be present in the source.
 * The check is deliberately literal: rephrasing is allowed, adding facts is not.
 */
export function checkFacts(source: { text: string; links?: string[] }, variant: string): FactCheck {
  const problems: FactProblem[] = [];
  const sourceNumbers = numbersIn(source.text);
  for (const value of numbersIn(variant)) if (!sourceNumbers.has(value)) problems.push({ kind: 'number', value });
  // Amounts written in words ("миллион", "млрд") are facts too: the order of magnitude must be in the source.
  const sourceWords = wordsOf(source.text);
  for (const group of MAGNITUDES) {
    const used = wordsOf(variant).find(word => group.some(form => form.endsWith('.') ? word === form.slice(0, -1) : word.startsWith(form)));
    if (used && !sourceWords.some(word => group.some(form => form.endsWith('.') ? word === form.slice(0, -1) : word.startsWith(form)))) problems.push({ kind: 'number', value: used });
  }
  const sourceStems = new Set(sourceWords.map(stem));
  for (const word of wordsOf(variant)) {
    if (!MONTH_WORD.test(word)) continue;
    const root = MONTHS.find(month => word.startsWith(month));
    if (root && !wordsOf(source.text).some(item => MONTH_WORD.test(item) && item.startsWith(root))) problems.push({ kind: 'month', value: word });
  }
  for (const name of namesIn(variant)) {
    const parts = wordsOf(name);
    if (parts.length && parts.every(part => part.length < 3 || sourceStems.has(stem(part)))) continue;
    problems.push({ kind: 'name', value: name });
  }
  const flatSource = normalizeText(source.text).replace(/\s+/g, ' ');
  for (const quote of quotesIn(variant)) if (!flatSource.includes(normalizeText(quote).replace(/\s+/g, ' '))) problems.push({ kind: 'quote', value: quote });
  const allowed = new Set([...linksIn(source.text), ...(source.links || [])]);
  for (const link of linksIn(variant)) if (![...allowed].some(item => item.startsWith(link) || link.startsWith(item))) problems.push({ kind: 'link', value: link });
  const unique = problems.filter((problem, index) => problems.findIndex(item => item.kind === problem.kind && item.value === problem.value) === index);
  return { ok: unique.length === 0, problems: unique };
}

/** Word trigrams; a short text falls back to single words so that it still compares sensibly. */
function shingles(text: string) {
  const words = wordsOf(text);
  const set = new Set<string>();
  if (words.length < 6) { words.forEach(word => set.add(word)); return set; }
  for (let index = 0; index + 2 < words.length; index++) set.add(`${words[index]} ${words[index + 1]} ${words[index + 2]}`);
  return set;
}
/** 0 = nothing in common, 1 = the same text. Jaccard similarity of word trigrams. */
export function similarity(a: string, b: string) {
  const left = shingles(a), right = shingles(b);
  if (!left.size && !right.size) return 1;
  let common = 0;
  for (const item of left) if (right.has(item)) common++;
  return common / (left.size + right.size - common);
}

const B0 = BigInt(0), B1 = BigInt(1), B64 = BigInt(64);
const FNV_OFFSET = BigInt('0xcbf29ce484222325'), FNV_PRIME = BigInt('0x100000001b3'), MASK = (B1 << B64) - B1;
function fnv64(value: string) {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(value)) hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK;
  return hash;
}
/** 64-bit SimHash as 16 hex digits: near-identical texts get hashes a few bits apart. */
export function simhash(text: string) {
  const weights = new Array(64).fill(0);
  for (const item of shingles(text)) {
    const hash = fnv64(item);
    for (let bit = 0; bit < 64; bit++) weights[bit] += (hash >> BigInt(bit)) & B1 ? 1 : -1;
  }
  let value = B0;
  for (let bit = 0; bit < 64; bit++) if (weights[bit] > 0) value |= B1 << BigInt(bit);
  return value.toString(16).padStart(16, '0');
}
export function hammingDistance(a: string, b: string) {
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), count = 0;
  while (value) { count += Number(value & B1); value >>= B1; }
  return count;
}
/** Two materials are the same story told twice (re-imported under another id, or copied). */
export const nearDuplicate = (a: string, b: string, maxBits = 3) => hammingDistance(a, b) <= maxBits;

export type VariantScore = { facts: FactCheck; toSource: number; closest: number; length: number; problems: string[] };
export const QUALITY = { maxToSource: 0.75, maxBetweenVariants: 0.55, minLength: 40 };
/**
 * Accepts a variant only when its facts check out, it is not a near copy of the source or of another variant,
 * and it fits the platform. Returns plain-language problems for the interface.
 */
export function scoreVariant(source: { text: string; links?: string[] }, text: string, others: string[], maxLength: number): VariantScore {
  const facts = checkFacts(source, text);
  const toSource = similarity(source.text, text);
  const closest = others.reduce((max, other) => Math.max(max, similarity(other, text)), 0);
  const problems: string[] = [];
  if (!facts.ok) problems.push(`факты не из источника: ${facts.problems.map(item => item.value).slice(0, 5).join(', ')}`);
  if (toSource > QUALITY.maxToSource) problems.push('почти копия исходного текста');
  if (closest > QUALITY.maxBetweenVariants) problems.push('слишком похож на другой вариант');
  if (text.trim().length < QUALITY.minLength) problems.push('слишком короткий');
  if (text.length > maxLength) problems.push(`длиннее ${maxLength} символов`);
  return { facts, toSource: round(toSource), closest: round(closest), length: text.length, problems };
}
const round = (value: number) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------- meaning, not only wording

const STOP = new Set(['это', 'что', 'как', 'для', 'при', 'его', 'она', 'они', 'оно', 'был', 'была', 'были', 'быть', 'есть', 'уже', 'еще', 'так', 'там', 'тут', 'или', 'если', 'когда', 'чем', 'где', 'кто', 'все', 'вся', 'весь', 'этот', 'эта', 'эти', 'того', 'тоже', 'также', 'только', 'после', 'перед', 'между', 'через', 'около', 'над', 'под', 'без', 'про', 'from', 'with', 'that', 'this', 'the', 'and', 'for']);
const ENDINGS = ['ившись', 'ывшись', 'вшись', 'иями', 'ости', 'ость', 'ивши', 'ывши', 'ейше', 'ями', 'ами', 'ими', 'ыми', 'его', 'ого', 'ему', 'ому', 'ешь', 'ишь', 'ете', 'ите', 'ить', 'ыть', 'ать', 'ять', 'еть', 'ующ', 'ост', 'ейш', 'вши', 'ах', 'ях', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ие', 'ые', 'ую', 'юю', 'ою', 'ею', 'ом', 'ем', 'им', 'ым', 'их', 'ых', 'ов', 'ев', 'ия', 'ья', 'ье', 'ии', 'ию', 'ью', 'ет', 'ют', 'ит', 'ят', 'ся', 'сь', 'а', 'я', 'о', 'е', 'и', 'ы', 'у', 'ю', 'ь', 'й'];
/** A light Russian stemmer: drops one usual ending (the longest that fits) so that the forms of one word meet. */
export function stem2(word: string) {
  const value = normalizeText(word).replace(/[^a-zа-я0-9]/g, '');
  if (/^[a-z0-9]+$/.test(value) || value.length <= 4) return value;
  const ending = ENDINGS.find(end => value.endsWith(end) && value.length - end.length >= 4);
  return ending ? value.slice(0, value.length - ending.length) : value;
}
/** The start all forms of a word share: its stem, and a short word without its last vowel («игра» → «игр»). */
export function wordRoot(word: string) {
  const stem = stem2(word);
  return stem.length >= 4 && /[аеиоуыэюяь]$/.test(stem) ? stem.slice(0, -1) : stem;
}
/** Whether a text speaks of a keyword: each of its words starts some word of the text, in any form. */
export function mentions(text: string, keyword: string) {
  const words = normalizeText(text).match(/[a-zа-я0-9]+/g) || [];
  const roots = (normalizeText(keyword).match(/[a-zа-я0-9]+/g) || []).map(wordRoot).filter(root => root.length >= 2);
  return roots.length > 0 && roots.every(root => words.some(word => word.startsWith(root)));
}
export const stemsOf = (text: string) => (normalizeText(text).match(/[a-zа-я0-9][a-zа-я0-9-]*/g) || []).filter(word => word.length >= 3 && !STOP.has(word)).map(stem2);

/** Inverse document frequency over a set of texts: words said in every story weigh little. */
export function idfOf(texts: string[]) {
  const df = new Map<string, number>();
  for (const text of texts) for (const term of new Set(stemsOf(text))) df.set(term, (df.get(term) || 0) + 1);
  const total = texts.length;
  return (term: string) => Math.log((total + 1) / ((df.get(term) || 0) + 1)) + 1;
}
function vector(text: string, idf: (term: string) => number) {
  const counts = new Map<string, number>();
  for (const term of stemsOf(text)) counts.set(term, (counts.get(term) || 0) + 1);
  const result = new Map<string, number>();
  for (const [term, count] of counts) result.set(term, (1 + Math.log(count)) * idf(term));
  return result;
}
/** Cosine of TF-IDF vectors of word stems: 1 = the same words in the same proportions. */
export function meaningSimilarity(a: string, b: string, idf: (term: string) => number = () => 1) {
  const left = vector(a, idf), right = vector(b, idf);
  let dot = 0, normLeft = 0, normRight = 0;
  for (const [term, weight] of left) { normLeft += weight * weight; const other = right.get(term); if (other) dot += weight * other; }
  for (const weight of right.values()) normRight += weight * weight;
  return normLeft && normRight ? dot / Math.sqrt(normLeft * normRight) : 0;
}
/** What a story is about in hard terms: its numbers, names and Latin words (brands, tickers). */
export function entitiesOf(text: string) {
  const result = new Set<string>();
  for (const value of numbersIn(text)) if (value.length >= 2) result.add(`#${value}`);
  for (const name of namesIn(text)) result.add(stem2(name));
  for (const word of text.match(/\b[A-Za-z][A-Za-z0-9]{2,}\b/g) || []) result.add(word.toLowerCase());
  return result;
}
const jaccard = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let common = 0; for (const item of a) if (b.has(item)) common++; return common / (a.size + b.size - common); };

export type Relation = 'identical' | 'paraphrase' | 'same_story' | 'similar_title' | 'independent';
export const RELATION_NAMES: Record<Relation, string> = { identical: 'та же публикация', paraphrase: 'пересказ того же текста', same_story: 'другая версия той же истории', similar_title: 'похожий заголовок, другая история', independent: 'самостоятельный материал' };
/**
 * How two texts relate. Wording (trigrams), meaning (stems), hard facts (numbers, names) and, when given, the
 * perceptual hashes of the pictures together tell a copy from a retelling, a retelling from another version of the
 * same story, and that from an unrelated story under a similar title.
 */
export function relate(a: { title: string; text: string; dhash?: string | null }, b: { title: string; text: string; dhash?: string | null }, idf: (term: string) => number = () => 1) {
  const textA = `${a.title}\n${a.text}`, textB = `${b.title}\n${b.text}`;
  const wording = similarity(textA, textB);
  const meaning = meaningSimilarity(textA, textB, idf);
  const titles = meaningSimilarity(a.title, b.title, idf);
  const facts = jaccard(entitiesOf(textA), entitiesOf(textB));
  const samePicture = Boolean(a.dhash && b.dhash && hammingDistance(a.dhash, b.dhash) <= 6);
  let kind: Relation = 'independent';
  if (normalizeText(textA).replace(/\s+/g, ' ').trim() === normalizeText(textB).replace(/\s+/g, ' ').trim() || wording >= 0.9) kind = 'identical';
  else if (wording >= 0.3 || (meaning >= 0.6 && facts >= 0.6)) kind = 'paraphrase';
  else if ((meaning >= 0.4 && facts >= 0.3) || facts >= 0.5 || (samePicture && meaning >= 0.25)) kind = 'same_story';
  else if (titles >= 0.5 && meaning < 0.3) kind = 'similar_title';
  return { kind, wording: round(wording), meaning: round(meaning), titles: round(titles), facts: round(facts), samePicture };
}
