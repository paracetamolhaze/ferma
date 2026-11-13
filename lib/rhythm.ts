/**
 * How often a person posts each kind of content. Either several times a day (`perDay`) or once in
 * `minDays`–`maxDays` days inside the usual `windows`. Hours are local to the persona.
 */
export type KindRhythm = { minDays: number; maxDays: number; windows: [number, number][]; weekend?: boolean; perDay?: number | null };
export type Rhythm = Record<'threads' | 'story' | 'post' | 'reel', KindRhythm>;
// 'reel' = an Instagram trial reel (shown to non-followers only): a generated ball-physics video.
export const KINDS = ['threads', 'story', 'post', 'reel'] as const;
export type Kind = typeof KINDS[number];

export const DEFAULT_RHYTHM: Rhythm = {
  threads: { minDays: 2, maxDays: 3, windows: [[20, 23]] },
  story: { minDays: 1, maxDays: 2, windows: [[9, 11], [18, 21]] },
  post: { minDays: 25, maxDays: 45, windows: [[17, 21]], weekend: true },
  reel: { minDays: 1, maxDays: 1, windows: [[9, 23]], perDay: 5 },
};
const DAY = 86_400_000, HOUR = 3_600_000;
// The nearest a new item may be planned: enough to draw it and hand it to Zernio in time.
export const MIN_LEAD_MS = 90 * 60_000;
// Several posts a day are spread over the hours a person is awake.
const WAKE = 9, SLEEP = 23;

/**
 * Picks the next moment to publish, like a person would: a random day in the gap after the last one,
 * a random minute inside one of the usual windows, weekends for rare posts.
 * `offsetMinutes` is the persona's UTC offset (Yekaterinburg: 300).
 */
export function planNext(rhythm: KindRhythm, lastDue: number | null, now: number, offsetMinutes: number, random: () => number = Math.random) {
  const offset = offsetMinutes * 60_000;
  const localDay = (ms: number) => Math.floor((ms + offset) / DAY);
  const pick = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  if (rhythm.perDay && rhythm.perDay >= 1) {
    const gap = ((SLEEP - WAKE) * HOUR) / rhythm.perDay;
    // Uneven gaps: sometimes two posts close together, sometimes a long pause.
    let due = Math.max(lastDue ?? now, now) + Math.max(10 * 60_000, gap * (0.5 + random()));
    const hour = (((due + offset) % DAY) + DAY) % DAY / HOUR;
    if (hour < WAKE || hour >= SLEEP) {
      const day = localDay(due) + (hour >= SLEEP ? 1 : 0);
      due = day * DAY + WAKE * HOUR - offset + Math.floor(random() * Math.min(gap, 3 * HOUR));
    }
    return Math.round(due / 60_000) * 60_000;
  }
  let day = lastDue === null ? localDay(now) + pick(0, 1) : localDay(lastDue) + pick(rhythm.minDays, rhythm.maxDays);
  // After a long pause (autopilot off, computer away) life resumes from today, not from a day long gone.
  day = Math.max(day, localDay(now));
  if (rhythm.weekend) while (![0, 6].includes(new Date(day * DAY).getUTCDay())) day++;
  const at = (dayIndex: number) => {
    const [from, to] = rhythm.windows[Math.floor(random() * rhythm.windows.length)];
    const minute = pick(from * 60, to * 60 - 1);
    return dayIndex * DAY + minute * 60_000 - offset;
  };
  let due = at(day);
  // Never in the past and never too soon to prepare: move on to the next suitable day.
  for (let guard = 0; due < now + MIN_LEAD_MS && guard < 14; guard++) {
    day++;
    if (rhythm.weekend) while (![0, 6].includes(new Date(day * DAY).getUTCDay())) day++;
    due = at(day);
  }
  return due;
}
