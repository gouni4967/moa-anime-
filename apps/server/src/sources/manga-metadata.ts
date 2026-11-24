import { setTimeout as delay } from 'node:timers/promises';
import { ApiFailure } from '../util.js';

type LocalizedTitles = Record<string, string>;
interface MangaDexWork {
  id: string;
  attributes: { title: LocalizedTitles; altTitles: LocalizedTitles[]; originalLanguage: string };
}

const titleKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
let nextLookupAt = 0;

export async function lookupMangaDexTitle(title: string) {
  const key = titleKey(title);
  if (!key) return {};

  const now = Date.now();
  const start = Math.max(now, nextLookupAt);
  if (start - now > 3500) throw new ApiFailure(503, 'manga-metadata-busy');
  nextLookupAt = start + 350;
  if (start > now) await delay(start - now);

  const url = new URL('https://api.mangadex.org/manga');
  url.searchParams.set('title', title);
  url.searchParams.set('limit', '10');
  const response = await fetch(url, {
    signal: AbortSignal.timeout(5500),
    redirect: 'error',
    headers: { 'User-Agent': 'MOA-Manga/1.0 (https://github.com/gouni4967/moa-anime-)' },
  });
  if (!response.ok) throw new ApiFailure(502, 'manga-metadata-unavailable');
  const payload = await response.json() as { result: string; data: MangaDexWork[] };
  if (payload.result !== 'ok' || !Array.isArray(payload.data)) throw new ApiFailure(502, 'manga-metadata-unavailable');

  const matches = payload.data.filter(({ attributes }) =>
    [attributes.title, ...attributes.altTitles].some(titles => Object.values(titles).some(name => titleKey(name) === key)),
  );
  if (matches.length !== 1) return {};
  const [{ id, attributes }] = matches;
  const titles = [attributes.title, ...attributes.altTitles];
  const korean = titles.map(names => names.ko).find(name => name && /[가-힣]/u.test(name));
  if (korean) return { title: korean, mangaDexUrl: `https://mangadex.org/title/${encodeURIComponent(id)}` };

  const canonical = [
    attributes.title[attributes.originalLanguage],
    ...attributes.altTitles.map(names => names[attributes.originalLanguage]),
    ...Object.values(attributes.title),
  ].find(name => name && titleKey(name) !== key);
  return { canonical };
}
