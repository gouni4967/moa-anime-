import { setTimeout as delay } from 'node:timers/promises';
import { ApiFailure } from '../util.js';

type LocalizedTitles = Record<string, string>;
interface MangaDexWork {
  id: string;
  attributes: { title: LocalizedTitles; altTitles: LocalizedTitles[]; originalLanguage: string };
}

const titleKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
let nextLookupAt = 0;

function matchesShortEnglishTitle(query: string, work: MangaDexWork) {
  const words = (value: string) => value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const short = words(query);
  if (short.length < 2 || short.join('').length < 8 || short.some(word => !/^[a-z0-9]+$/.test(word))) return false;
  return [work.attributes.title, ...work.attributes.altTitles].some(({ en }) => {
    if (!en) return false;
    const full = words(en);
    const tail = full.slice(short.length);
    if (!tail.length || tail.length > 3 || /\b(?:volume|chapter|anthology|side story|spin off|sequel|prequel|fan comic|fancomic)\b/.test(tail.join(' '))) return false;
    return short.every((word, index) => full[index] === word);
  });
}

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
  const payload = await response.json() as { result: string; total?: number; data: MangaDexWork[] };
  if (payload.result !== 'ok' || !Array.isArray(payload.data)) throw new ApiFailure(502, 'manga-metadata-unavailable');

  const matches = payload.data.filter(({ attributes }) =>
    [attributes.title, ...attributes.altTitles].some(titles => Object.values(titles).some(name => titleKey(name) === key)),
  );
  if (matches.length > 1) return {};
  const exact = matches[0];
  // A shortened English title can point to the original title, which Wikidata then checks independently.
  const only = payload.total === 1 && payload.data.length === 1 ? payload.data[0] : undefined;
  const work = exact ?? (only && matchesShortEnglishTitle(title, only) ? only : undefined);
  if (!work) return {};

  const { id, attributes } = work;
  const titles = [attributes.title, ...attributes.altTitles];
  const korean = titles.map(names => names.ko).find(name => name && /[가-힣]/u.test(name));
  if (exact && korean) return { title: korean, mangaDexUrl: `https://mangadex.org/title/${encodeURIComponent(id)}` };

  const candidates = [
    attributes.title[attributes.originalLanguage],
    ...attributes.altTitles.map(names => names[attributes.originalLanguage]),
    ...Object.values(attributes.title),
    ...titles.map(names => names.en),
  ];
  const distinct = new Map<string, string>();
  for (const name of candidates) {
    if (!name) continue;
    const normalized = titleKey(name);
    if (normalized && normalized !== key && !distinct.has(normalized)) distinct.set(normalized, name);
  }
  const [canonical, alternateCanonical] = [...distinct.values()];
  return { canonical, alternateCanonical };
}
