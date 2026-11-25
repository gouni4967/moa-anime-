import { load } from 'cheerio';
import { ApiFailure } from '../util.js';
import { compatibilityHttp } from './extensions/http.js';
import type { SourceItem, SourcePage } from './extensions/index.js';

const origin = 'https://weloma.art';
export const maxWeLoMaUpdatePages = 128;
const dayMs = 24 * 60 * 60_000;
const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const units: Record<string, number> = { second: 1000, minute: 60_000, hour: 60 * 60_000, day: dayMs, week: 7 * dayMs };
// Recent update dates use Korea Standard Time (UTC+09:00).
const koreanDay = (time: number) => Math.floor((time + 9 * units.hour) / dayMs);
type Update = { item: SourceItem; publishedAt: number };
type UpdatePage = { updates: Update[]; hasNextPage: boolean };
const pages = new Map<number, { expires: number; result: Promise<UpdatePage> }>();

export function isWeLoMaSource(name: unknown, url: unknown) {
  return typeof name === 'string' && /^weloma$/i.test(name) && typeof url === 'string' && /^https:\/\/weloma\.art\/?$/i.test(url);
}

function publishedAt(datetime: string | undefined, label: string, now: number) {
  if (datetime) {
    const absolute = Date.parse(datetime);
    if (Number.isFinite(absolute) && absolute <= now + 60_000) return absolute;
  }
  const value = label.trim().toLowerCase();
  if (value === 'just now') return now;
  const relative = /^(\d+)\s*(second|minute|hour|day|week)s?\s+ago$/.exec(value);
  if (!relative) return undefined;
  const amount = Number(relative[1]);
  if (!Number.isSafeInteger(amount) || amount > 31_536_000) return undefined;
  return now - amount * units[relative[2]];
}

export function parseWeLoMaUpdates(html: string, now: number): UpdatePage {
  const $ = load(html);
  const updates: Update[] = [];
  for (const row of $('.thumb-item-flow').toArray()) {
    const link = $(row).find('.series-title a').first();
    const href = link.attr('href');
    const name = link.text().trim();
    const time = $(row).find('time.timeago').first();
    const timestamp = publishedAt(time.attr('datetime'), time.text() || time.attr('title') || '', now);
    if (!href || !/^\/m\/[A-Za-z0-9_-]+$/.test(href) || !name || timestamp === undefined) continue;
    const style = $(row).find('.img-in-ratio').first().attr('style') || '';
    const imageUrl = /url\(\s*['"]?(https?:\/\/[^'")\s]+)/i.exec(style)?.[1];
    updates.push({ item: { name, link: href, imageUrl }, publishedAt: timestamp });
  }
  const last = $('ul.pagination.pagination-v4 a').last();
  return { updates, hasNextPage: last.length > 0 && !last.hasClass('disabled') };
}

async function loadUpdates(page: number) {
  const url = new URL('/manga-list.html', origin);
  url.search = new URLSearchParams({ name: '', sort: 'last_update', page: String(page) }).toString();
  // WeLoMa redirects the list query to a short link before returning the HTML.
  const result = await compatibilityHttp({ url: url.toString() }, AbortSignal.timeout(8000), [], 1024 * 1024);
  if (result.statusCode !== 200) throw new ApiFailure(502, 'manga-updates-unavailable');
  return parseWeLoMaUpdates(result.bytes.toString('utf8'), Date.now());
}

function updatesPage(page: number, now: number) {
  let entry = pages.get(page);
  if (!entry || entry.expires <= now) {
    const result = loadUpdates(page);
    entry = { expires: now + 90_000, result };
    pages.set(page, entry);
    result.catch(() => { if (pages.get(page)?.result === result) pages.delete(page); });
  }
  return entry.result;
}

function oldestUpdateDay(page: UpdatePage) {
  return Math.min(Infinity, ...page.updates.map(update => koreanDay(update.publishedAt)));
}

async function firstPossiblePage(targetDay: number, now: number) {
  const reachesTarget = (data: UpdatePage) => oldestUpdateDay(data) <= targetDay || !data.hasNextPage;
  let low = 0;
  let high = 1;
  let data = await updatesPage(high, now);
  // WeLoMa sorts newest first. Skip over pages that contain only newer updates.
  while (!reachesTarget(data) && high < maxWeLoMaUpdatePages) {
    low = high;
    high = Math.min(high * 2, maxWeLoMaUpdatePages);
    data = await updatesPage(high, now);
  }
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const candidate = await updatesPage(mid, now);
    if (reachesTarget(candidate)) {
      high = mid;
      data = candidate;
    } else {
      low = mid;
    }
  }
  return { page: high, data };
}

export async function weLoMaUpdates(requestedPage: number, weekday: string): Promise<SourcePage & { page: number }> {
  const now = Date.now();
  const today = koreanDay(now);
  const targetIndex = weekdays.indexOf(weekday);
  if (targetIndex < 0) throw new ApiFailure(400, 'manga-updates-invalid-weekday');
  const todayIndex = new Date(today * dayMs).getUTCDay();
  const targetDay = today - (todayIndex - targetIndex + 7) % 7;
  const { page, data } = requestedPage === 1
    ? await firstPossiblePage(targetDay, now)
    : { page: requestedPage, data: await updatesPage(requestedPage, now) };

  return {
    page,
    list: data.updates.filter(update => koreanDay(update.publishedAt) === targetDay).map(update => update.item),
    hasNextPage: data.hasNextPage && page < maxWeLoMaUpdatePages && oldestUpdateDay(data) >= targetDay,
  };
}
