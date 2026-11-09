const WORD = /code|otp|\bpin\b|passcode|password|verification|verify|confirm|security|код|пароль|подтвержд/gi;
// Case-sensitive on purpose: real codes are digits or capitals, ordinary words like "user1234" are not.
const VALUE = /(?<![\w-])([A-Z]{1,4}-\d{4,8}|\d{3}[- ]\d{3}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8})(?![\w-])/g;
const ALONE_ON_LINE = /^\s*(\d{4,8}|\d{3}[- ]\d{3})\s*$/m;
const isYear = (value: string) => /^(19|20)\d{2}$/.test(value);
const values = (text: string) => [...text.matchAll(VALUE)].map(match => match[1]).filter(value => !isYear(value));

function pick(source: string) {
  for (const word of source.matchAll(WORD)) {
    const start = word.index, end = start + word[0].length;
    const after = source.slice(end, end + 60);
    const before = source.slice(Math.max(0, start - 40), start).split('\n').pop() || '';
    const value = values(after)[0] || values(before).at(-1);
    if (value) return value;
  }
  const alone = source.match(ALONE_ON_LINE)?.[1];
  return alone && !isYear(alone) ? alone : null;
}
export function extractCode(subject: string | null, text: string | null) {
  const value = pick(subject || '') || pick((text || '').slice(0, 5000));
  return value ? value.replace(' ', '') : null;
}
