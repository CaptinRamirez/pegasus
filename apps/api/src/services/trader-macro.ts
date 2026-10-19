import type { TraderHeadline, TraderMacro, TraderMacroEvent } from '@pegasus/shared';

/**
 * The macro block of the trader's dossier: the economic calendar (ForexFactory's weekly JSON, the free feed most
 * trading tools read: time, impact, forecast and previous, never the actual figure) and the latest headlines of a few
 * public RSS feeds (the Federal Reserve's press releases, CNBC Economy, MarketWatch, Cointelegraph). Read through a
 * cache: the calendar once an hour, the feeds every ten minutes at most. A feed that cannot be read is left out with a
 * note; the dossier never waits on news. Headlines are third-party text: the model is told they are data.
 */

export const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
export const NEWS_FEEDS: ReadonlyArray<{ source: string; url: string }> = [
  { source: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { source: 'CNBC Economy', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { source: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  { source: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const CALENDAR_TTL_MS = HOUR_MS;
const NEWS_TTL_MS = 10 * MINUTE_MS;
const FETCH_TIMEOUT_MS = 15_000;
/** Headlines older than this are not shown */
const HEADLINE_HOURS = 6;
const HEADLINES_PER_SOURCE = 4;
const HEADLINES_MAX = 16;
const TITLE_MAX = 200;

export interface RawCalendarEvent {
  title: string;
  country: string;
  /** ISO time with its offset, e.g. 2026-10-20T08:30:00-04:00 */
  date: string;
  impact: string;
  forecast: string;
  previous: string;
}

export interface RawHeadline {
  time: number;
  source: string;
  title: string;
}

export interface TraderMacroSource {
  read(now: number): Promise<TraderMacro>;
}

export const NO_MACRO: TraderMacroSource = { read: async () => ({ calendar: [], headlines: [], notes: ['news off (TRADER_NEWS=0)'] }) };

/** The text of an RSS field: CDATA unwrapped, tags dropped, entities decoded, spaces collapsed. */
function text(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The items of an RSS 2.0 feed with a title and a date. shortcut: regex parsing, enough for these four feeds; use an XML parser if one breaks it. */
export function parseRss(xml: string, source: string): RawHeadline[] {
  const out: RawHeadline[] = [];
  for (const item of xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? []) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(item)?.[1];
    const date = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(item)?.[1];
    if (title === undefined || date === undefined) continue;
    const time = Date.parse(text(date));
    const t = text(title).slice(0, TITLE_MAX);
    if (Number.isFinite(time) && t !== '') out.push({ time, source, title: t });
  }
  return out;
}

/** The releases that matter around `now`: high impact anywhere and medium impact for the US, from two hours ago to a day ahead, oldest first. */
export function calendarWindow(events: readonly RawCalendarEvent[], now: number): TraderMacroEvent[] {
  const out: TraderMacroEvent[] = [];
  for (const e of events) {
    const time = Date.parse(e.date);
    if (!Number.isFinite(time) || time < now - 2 * HOUR_MS || time > now + 24 * HOUR_MS) continue;
    if (!(e.impact === 'High' || (e.country === 'USD' && e.impact === 'Medium'))) continue;
    out.push({ time, title: e.title, country: e.country, impact: e.impact, forecast: e.forecast, previous: e.previous, minutesFromNow: Math.round((time - now) / MINUTE_MS) });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** The headlines of the last hours, newest first, a few per source. */
export function headlinesWindow(items: readonly RawHeadline[], now: number): TraderHeadline[] {
  const recent = items.filter((h) => h.time <= now && h.time >= now - HEADLINE_HOURS * HOUR_MS).sort((a, b) => b.time - a.time);
  const perSource = new Map<string, number>();
  const out: TraderHeadline[] = [];
  for (const h of recent) {
    const n = perSource.get(h.source) ?? 0;
    if (n >= HEADLINES_PER_SOURCE) continue;
    perSource.set(h.source, n + 1);
    out.push({ time: h.time, source: h.source, title: h.title, minutesAgo: Math.round((now - h.time) / MINUTE_MS) });
    if (out.length >= HEADLINES_MAX) break;
  }
  return out;
}

/** The calendar and the feeds over HTTP, cached. */
export class FeedMacroSource implements TraderMacroSource {
  private calendar: { at: number; events: RawCalendarEvent[] } | null = null;
  private news: { at: number; items: RawHeadline[]; notes: string[] } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { fetchImpl?: typeof fetch } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get(url: string): Promise<string> {
    const res = await this.fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 (Pegasus paper trader)' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  async read(now: number): Promise<TraderMacro> {
    const notes: string[] = [];
    if (this.calendar === null || now - this.calendar.at >= CALENDAR_TTL_MS) {
      try {
        const parsed: unknown = JSON.parse(await this.get(CALENDAR_URL));
        if (!Array.isArray(parsed)) throw new Error('not a list');
        this.calendar = { at: now, events: parsed.filter((e): e is RawCalendarEvent => typeof e === 'object' && e !== null && typeof (e as RawCalendarEvent).date === 'string' && typeof (e as RawCalendarEvent).title === 'string') };
      } catch (err) {
        notes.push(`economic calendar not read (${(err as Error).message})${this.calendar ? ': the last one is used' : ''}`);
        // a failed read is tried again at the next hour, not at every close
        if (this.calendar) this.calendar = { ...this.calendar, at: now };
      }
    }
    if (this.news === null || now - this.news.at >= NEWS_TTL_MS) {
      const items: RawHeadline[] = [];
      const newsNotes: string[] = [];
      await Promise.all(
        NEWS_FEEDS.map(async (f) => {
          try {
            items.push(...parseRss(await this.get(f.url), f.source));
          } catch (err) {
            newsNotes.push(`${f.source} not read (${(err as Error).message})`);
          }
        }),
      );
      this.news = { at: now, items, notes: newsNotes };
    }
    return { calendar: calendarWindow(this.calendar?.events ?? [], now), headlines: headlinesWindow(this.news.items, now), notes: [...notes, ...this.news.notes] };
  }
}
