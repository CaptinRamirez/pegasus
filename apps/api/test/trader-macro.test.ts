import { describe, expect, it } from 'vitest';
import { CALENDAR_URL, calendarWindow, FeedMacroSource, headlinesWindow, NEWS_FEEDS, parseRss, type RawCalendarEvent } from '../src/services/trader-macro.js';

const NOW = Date.UTC(2026, 9, 20, 12, 0);
const H = 3_600_000;

describe('the trader macro block', () => {
  it('reads RSS items: CDATA, entities, tags, dates with a zone', () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>x</title>
      <item><title><![CDATA[Fed&#39;s <b>Powell</b> &amp; markets]]></title><pubDate><![CDATA[Tue, 20 Oct 2026 11:30:00 GMT]]></pubDate></item>
      <item><title>SpaceX&#x2019;s stock</title><pubDate>Tue, 20 Oct 2026 10:00:00 +0000</pubDate></item>
      <item><title>no date</title></item>
    </channel></rss>`;
    expect(parseRss(xml, 'Feed')).toEqual([
      { time: NOW - 30 * 60_000, source: 'Feed', title: "Fed's Powell & markets" },
      { time: NOW - 2 * H, source: 'Feed', title: 'SpaceX’s stock' },
    ]);
    expect(parseRss('not xml', 'Feed')).toEqual([]);
  });

  it('keeps the releases that matter around now: high impact anywhere, medium for the US, two hours back to a day ahead', () => {
    const ev = (title: string, country: string, impact: string, hoursFromNow: number): RawCalendarEvent => ({ title, country, impact, date: new Date(NOW + hoursFromNow * H).toISOString().replace('Z', '+00:00'), forecast: '0.3%', previous: '0.4%' });
    const out = calendarWindow([ev('CPI m/m', 'USD', 'High', 0.5), ev('Jobless Claims', 'USD', 'Medium', 3), ev('German PPI', 'EUR', 'Medium', 1), ev('ECB Rate', 'EUR', 'High', -1), ev('Old', 'USD', 'High', -5), ev('Far', 'USD', 'High', 30), ev('Holiday', 'USD', 'Holiday', 1)], NOW);
    expect(out.map((e) => [e.title, e.minutesFromNow])).toEqual([
      ['ECB Rate', -60],
      ['CPI m/m', 30],
      ['Jobless Claims', 180],
    ]);
    expect(out[1]).toMatchObject({ country: 'USD', impact: 'High', forecast: '0.3%', previous: '0.4%' });
  });

  it('shows the headlines of the last six hours, newest first, four per source at most', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({ time: NOW - i * H * 0.5, source: 'A', title: `a${i}` })),
      { time: NOW - 7 * H, source: 'B', title: 'too old' },
      { time: NOW + H, source: 'B', title: 'future' },
      { time: NOW - 0.25 * H, source: 'B', title: 'b' },
    ];
    expect(headlinesWindow(items, NOW).map((h) => `${h.source}:${h.title}:${h.minutesAgo}`)).toEqual(['A:a0:0', 'B:b:15', 'A:a1:30', 'A:a2:60', 'A:a3:90']);
  });

  it('reads through a cache and notes what it could not read', async () => {
    let calls = 0;
    const calendar: RawCalendarEvent[] = [{ title: 'CPI m/m', country: 'USD', impact: 'High', date: new Date(NOW + H).toISOString(), forecast: '', previous: '' }];
    const fetchImpl = (async (url: string) => {
      calls += 1;
      if (url === CALENDAR_URL) return new Response(JSON.stringify(calendar));
      if (url === NEWS_FEEDS[0]?.url) return new Response(`<rss><item><title>Fed statement</title><pubDate>${new Date(NOW - H).toUTCString()}</pubDate></item></rss>`);
      return new Response('nope', { status: 503 });
    }) as typeof fetch;
    const source = new FeedMacroSource({ fetchImpl });
    const first = await source.read(NOW);
    expect(first.calendar.map((e) => e.title)).toEqual(['CPI m/m']);
    expect(first.headlines.map((h) => h.title)).toEqual(['Fed statement']);
    expect(first.notes).toHaveLength(NEWS_FEEDS.length - 1);
    expect(first.notes[0]).toMatch(/HTTP 503/);
    const before = calls;
    await source.read(NOW + 5 * 60_000);
    expect(calls).toBe(before);
    // ten minutes on the feeds are read again, the calendar not before the hour
    await source.read(NOW + 11 * 60_000);
    expect(calls).toBe(before + NEWS_FEEDS.length);
  });
});
