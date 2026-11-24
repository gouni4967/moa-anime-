export interface KoreanMangaInfo {
  title: string;
  introduction?: string;
  articleUrl?: string;
}

interface WikidataEntity {
  labels?: { ko?: { value: string } };
  sitelinks?: { kowiki?: { title: string } };
  claims?: { P31?: Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }> };
}

const mangaTypes = new Set(['Q8274', 'Q21198342']);

async function wikimedia<T>(host: 'www.wikidata.org' | 'ko.wikipedia.org', params: Record<string, string>, signal: AbortSignal): Promise<T> {
  const query = new URLSearchParams({ ...params, origin: '*', format: 'json', formatversion: '2' });
  const response = await fetch(`https://${host}/w/api.php?${query}`, {
    signal,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: { 'Api-User-Agent': 'MOA-Manga/1.0 (https://github.com/gouni4967/moa-anime-)' },
  });
  if (!response.ok) throw new Error(`Wikimedia HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function titleKey(title: string) {
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export async function findKoreanMangaInfo(sourceTitle: string, signal: AbortSignal): Promise<KoreanMangaInfo | null> {
  const title = sourceTitle.replace(/\s*[-–—]\s*raw\s*$/i, '').trim();
  const key = titleKey(title);
  if (!key) return null;
  const language = /[가-힣]/u.test(title) ? 'ko' : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(title) ? 'ja' : 'en';
  const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const results = await wikimedia<{ search?: Array<{ id: string; match?: { text?: string } }> }>(
    'www.wikidata.org', { action: 'wbsearchentities', search: title, language, limit: '10' }, lookupSignal,
  );
  const ids = results.search?.filter(item => item.match?.text && titleKey(item.match.text) === key).map(item => item.id) ?? [];
  if (!ids.length) return null;

  const { entities } = await wikimedia<{ entities?: Record<string, WikidataEntity> }>('www.wikidata.org', {
    action: 'wbgetentities', ids: ids.join('|'), props: 'labels|claims|sitelinks', languages: 'ko', sitefilter: 'kowiki',
  }, lookupSignal);
  const matches = Object.values(entities ?? {}).filter(entity => entity.claims?.P31?.some(claim =>
    mangaTypes.has(claim.mainsnak?.datavalue?.value?.id ?? ''),
  ));
  if (matches.length !== 1) return null;
  const [match] = matches;
  const article = match.sitelinks?.kowiki?.title;
  const koreanTitle = match.labels?.ko?.value || article;
  if (!koreanTitle || !/[가-힣]/u.test(koreanTitle)) return null;
  if (!article) return { title: koreanTitle };

  const articleUrl = `https://ko.wikipedia.org/wiki/${encodeURIComponent(article.replaceAll(' ', '_'))}`;
  try {
    const result = await wikimedia<{ query?: { pages?: Array<{ extract?: string }> } }>('ko.wikipedia.org', {
      action: 'query', prop: 'extracts', exintro: '1', explaintext: '1', redirects: '1', titles: article,
    }, lookupSignal);
    const introduction = result.query?.pages?.[0]?.extract?.trim();
    return { title: koreanTitle, introduction, articleUrl };
  } catch {
    return { title: koreanTitle, articleUrl };
  }
}

export function koreanMangaChapterTitle(title: string) {
  const match = /^chapter\s+#?(\d+(?:\.\d+)?)(?=\s|[:.–—-]|$)/i.exec(title.trim());
  if (!match) return title;
  const remainder = title.trim().slice(match[0].length).replace(/^\s*[:–—-]\s*/, '').trim();
  return remainder ? `${match[1]}화 · ${remainder}` : `${match[1]}화`;
}
