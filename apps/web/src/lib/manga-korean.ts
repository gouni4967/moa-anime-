interface KoreanMangaTitle {
  title: string;
  article?: string;
}

interface WikidataEntity {
  labels?: { ko?: { value: string } };
  sitelinks?: { kowiki?: { title: string } };
  claims?: { P31?: Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }> };
}

interface CachedMangaTitle {
  value: KoreanMangaTitle | null;
  expiresAt: number;
}

const mangaTypes = new Set(['Q8274', 'Q21198342']);

// WeLoMa uses these English aliases instead of the standard manga titles.
const koreanTitleAliases = new Map<string, KoreanMangaTitle>([
  ['piratekingmanga', { title: '원피스', article: '원피스 (만화)' }],
  ['sorceryfightmanga', { title: '주술회전', article: '주술회전' }],
  ['inregardstomyreincarnationasaslimemanga', { title: '전생했더니 슬라임이었던 건에 대하여' }],
  ['shangrilafrontiershittygameshunterchallengesgodlygame', { title: '샹그릴라 프론티어' }],
]);
const titleCacheKey = 'moa.manga.koreanTitles.v1';
const maxCachedTitles = 250;
const maxConcurrentTitleLookups = 4;
const waitingTitleLookups: Array<() => void> = [];
let activeTitleLookups = 0;

function readTitleCache(): Record<string, CachedMangaTitle> {
  try {
    const entries = JSON.parse(localStorage.getItem(titleCacheKey) ?? '{}');
    return entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
  } catch {
    return {};
  }
}

function cacheTitle(key: string, value: KoreanMangaTitle | null) {
  try {
    const entries = readTitleCache();
    const now = Date.now();
    delete entries[key];
    const remaining = Object.entries(entries)
      .filter(([, entry]) => entry?.expiresAt > now)
      .slice(-(maxCachedTitles - 1));
    const expiresAt = now + (value ? 14 * 24 : 6) * 60 * 60_000;
    localStorage.setItem(titleCacheKey, JSON.stringify(Object.fromEntries([...remaining, [key, { value, expiresAt }]])));
  } catch {
    // The query cache still works when browser storage is unavailable.
  }
}

async function wikimedia<T>(host: 'www.wikidata.org' | 'ko.wikipedia.org', params: Record<string, string>, signal: AbortSignal): Promise<T> {
  const query = new URLSearchParams({ ...params, origin: '*', format: 'json', formatversion: '2' });
  const response = await fetch(`https://${host}/w/api.php?${query}`, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { 'Api-User-Agent': 'MOA-Manga/1.0 (https://github.com/gouni4967/moa-anime-)' },
  });
  if (!response.ok) throw new Error(`Wikimedia HTTP ${response.status}`);
  const data = await response.json() as T & { error?: { code: string } };
  if (data.error) throw new Error(`Wikimedia API ${data.error.code}`);
  return data;
}

function titleKey(title: string) {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function mangaLookupTitle(title: string) {
  return title.replace(/\s*[-–—]\s*raw\s*$/i, '').trim();
}

export async function findKoreanMangaTitle(title: string, signal: AbortSignal): Promise<KoreanMangaTitle | null> {
  signal.throwIfAborted();
  const alias = koreanTitleAliases.get(titleKey(title));
  if (alias) return alias;
  const lookupTitle = title.replace(/\s*\(manga\)\s*$/i, '').trim();
  const key = `title:${lookupTitle.toLowerCase()}`;
  const cached = readTitleCache()[key];
  if (cached?.expiresAt > Date.now()) return cached.value;

  if (activeTitleLookups < maxConcurrentTitleLookups) {
    activeTitleLookups++;
  } else {
    await new Promise<void>(resolve => waitingTitleLookups.push(resolve));
  }

  try {
    signal.throwIfAborted();
    const result = await lookupKoreanMangaTitle(lookupTitle, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
    cacheTitle(key, result);
    return result;
  } finally {
    const next = waitingTitleLookups.shift();
    if (next) next();
    else activeTitleLookups--;
  }
}

async function lookupKoreanMangaTitle(title: string, signal: AbortSignal): Promise<KoreanMangaTitle | null> {
  const key = titleKey(title);
  if (!key) return null;
  const language = /[가-힣]/u.test(title) ? 'ko' : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title) ? 'ja' : 'en';
  const results = await wikimedia<{ search?: Array<{ id: string; match?: { text?: string } }> }>(
    'www.wikidata.org', { action: 'wbsearchentities', search: title, language, limit: '10' }, signal,
  );
  const ids = results.search?.filter(item => item.match?.text && titleKey(item.match.text) === key).map(item => item.id) ?? [];
  if (!ids.length) return null;

  const { entities } = await wikimedia<{ entities?: Record<string, WikidataEntity> }>('www.wikidata.org', {
    action: 'wbgetentities', ids: ids.join('|'), props: 'labels|claims|sitelinks', languages: 'ko', sitefilter: 'kowiki',
  }, signal);
  const matches = Object.values(entities ?? {}).filter(entity => entity.claims?.P31?.some(claim =>
    mangaTypes.has(claim.mainsnak?.datavalue?.value?.id ?? ''),
  ));
  if (matches.length !== 1) return null;
  const [match] = matches;
  const article = match.sitelinks?.kowiki?.title;
  const koreanTitle = match.labels?.ko?.value || article;
  if (!koreanTitle || !/[가-힣]/u.test(koreanTitle)) return null;
  return { title: koreanTitle, article };
}

export async function findKoreanMangaIntroduction(article: string, signal: AbortSignal) {
  const result = await wikimedia<{ query?: { pages?: Array<{ extract?: string }> } }>('ko.wikipedia.org', {
    action: 'query', prop: 'extracts', exintro: '1', explaintext: '1', redirects: '1', titles: article,
  }, AbortSignal.any([signal, AbortSignal.timeout(8000)]));
  return {
    text: result.query?.pages?.[0]?.extract?.trim(),
    url: `https://ko.wikipedia.org/wiki/${encodeURIComponent(article.replaceAll(' ', '_'))}`,
  };
}

export function koreanMangaChapterTitle(title: string) {
  const match = /^chapter\s+#?(\d+(?:\.\d+)?)(?=\s|[:.–—-]|$)/i.exec(title.trim());
  if (!match) return title;
  const remainder = title.trim().slice(match[0].length).replace(/^\s*[:–—-]\s*/, '').trim();
  return remainder ? `${match[1]}화 · ${remainder}` : `${match[1]}화`;
}
