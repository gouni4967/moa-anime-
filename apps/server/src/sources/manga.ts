import { createHash } from 'node:crypto';
import type { BrowseSelection, MangaCard, MangaDetail, MangaPages, Page } from '@moa/shared';
import type { FastifyInstance } from 'fastify';
import { idParams, object, pageQuery, params, profile, query } from '../http.js';
import { ApiFailure } from '../util.js';
import type { SourceItem, SourcePage } from './extensions/index.js';
import { lookupMangaBakaTitle, lookupMangaDexTitle } from './manga-metadata.js';
import { browseSelection } from './schema.js';
import type { Sources } from './service.js';

const idFor = (...parts: string[]) => 'manga-' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
const text = (value: unknown, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const headers = (value: unknown): Record<string, string> => value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key, val]) => /^[\w-]+$/.test(key) && typeof val === 'string' && !/[\r\n]/.test(val)).slice(0, 64)) : {};

export class Manga {
  constructor(private sources: Sources) {}
  private get db() { return this.sources.db; }

  private assertProfile(id: string) {
    const row = this.db.get('SELECT kids FROM profiles WHERE id=?', id);
    if (!row) throw new ApiFailure(401, 'profile-required');
    if (row.kids) throw new ApiFailure(403, 'manga-unrated');
  }

  private work(id: string) {
    const row = this.db.get('SELECT * FROM manga_works WHERE id=?', id);
    if (!row) throw new ApiFailure(404, 'manga-not-found');
    return row;
  }

  koreanTitle(title: string, profileId: string, provider: 'mangadex' | 'mangabaka') {
    this.assertProfile(profileId);
    return provider === 'mangabaka' ? lookupMangaBakaTitle(title.trim()) : lookupMangaDexTitle(title.trim());
  }

  browse(sourceId: string, profileId: string, page: number, term: string, mode: 'popular' | 'latest', selection?: BrowseSelection): Promise<Page<MangaCard>> {
    this.assertProfile(profileId);
    return this.sources.mangaRead(sourceId, 'list', { mode: term ? 'search' : mode, page, query: term }, result => {
      const raw = result as SourcePage;
      if (!raw || !Array.isArray(raw.list)) throw new ApiFailure(502, 'source-invalid-response');
      const items = new Map<string, MangaCard>();
      this.db.transaction(() => {
        for (const item of raw.list.slice(0, 500)) {
          if (!item || typeof item.link !== 'string' || !item.link || item.link.length > 16384) continue;
          const title = text(item.name).trim();
          if (!title) continue;
          const id = idFor(sourceId, item.link);
          const poster = this.sources.mangaImage(sourceId, item.imageUrl, headers(item.imageHeaders));
          this.db.run(`INSERT INTO manga_works(id,source_id,url,title,poster) VALUES(?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET title=excluded.title,poster=COALESCE(excluded.poster,manga_works.poster)`,
          id, sourceId, item.link, title, poster ?? null);
          items.set(id, { id, title, poster });
        }
      });
      return { items: [...items.values()], page, hasNextPage: Boolean(raw.hasNextPage) };
    }, selection);
  }

  detail(id: string, profileId: string): Promise<MangaDetail> {
    this.assertProfile(profileId);
    const work = this.work(id);
    return this.sources.mangaRead(work.source_id, 'detail', { workUrl: work.url }, result => {
      const raw = result as SourceItem;
      if (!raw || !Array.isArray(raw.chapters)) throw new ApiFailure(502, 'source-invalid-response');
      const title = text(raw.name).trim() || work.title;
      const chapters = new Map<string, { id: string; title: string; url: string }>();
      for (const chapter of raw.chapters.slice(0, 20000).reverse()) {
        if (!chapter || typeof chapter.url !== 'string' || !chapter.url || chapter.url.length > 16384) continue;
        const chapterId = idFor(id, chapter.url);
        if (!chapters.has(chapterId)) chapters.set(chapterId, { id: chapterId, url: chapter.url, title: text(chapter.name) || `${chapters.size + 1}화` });
      }
      const all = [...chapters.values()];
      const poster = this.sources.mangaImage(work.source_id, raw.imageUrl, headers(raw.imageHeaders)) ?? work.poster ?? undefined;
      this.db.transaction(() => {
        this.db.run('UPDATE manga_works SET title=?,poster=? WHERE id=?', title, poster ?? null, id);
        this.db.run('DELETE FROM manga_chapters WHERE work_id=?', id);
        for (const [i, chapter] of all.entries()) this.db.run('INSERT INTO manga_chapters VALUES(?,?,?,?,?)', chapter.id, id, chapter.url, chapter.title, i);
      });
      return {
        id, title, poster, sourceId: work.source_id, author: text(raw.author).trim() || undefined,
        description: text(raw.description, 20000), chapters: all.map(({ id, title }) => ({ id, title })),
      };
    });
  }

  pages(chapterId: string, profileId: string): Promise<MangaPages> {
    this.assertProfile(profileId);
    const chapter = this.db.get('SELECT * FROM manga_chapters WHERE id=?', chapterId);
    if (!chapter) throw new ApiFailure(404, 'manga-chapter-not-found');
    const work = this.work(chapter.work_id);
    return this.sources.mangaRead(work.source_id, 'pages', { chapterUrl: chapter.url }, result => {
      if (!Array.isArray(result) || !result.length || result.length > 2000) throw new ApiFailure(502, 'manga-pages-unavailable');
      const images: string[] = [];
      this.db.transaction(() => {
        for (const page of result) {
          const image = this.sources.mangaImage(work.source_id, page?.url, headers(page?.headers));
          if (!image) throw new ApiFailure(502, 'manga-pages-unavailable');
          images.push(image);
        }
      });
      const previous = this.db.get('SELECT id FROM manga_chapters WHERE work_id=? AND ordinal=?', work.id, chapter.ordinal - 1);
      const next = this.db.get('SELECT id FROM manga_chapters WHERE work_id=? AND ordinal=?', work.id, chapter.ordinal + 1);
      return { workId: work.id, title: chapter.title, images, previousId: previous?.id, nextId: next?.id };
    });
  }
}

export function registerMangaRoutes(app: FastifyInstance, sources: Sources) {
  const manga = new Manga(sources);
  const titleQuery = object({ title: { type: 'string', minLength: 1, maxLength: 500 } }, ['title']);
  app.get('/api/manga/metadata/korean-title', { schema: { querystring: titleQuery } },
    async req => manga.koreanTitle(query(req).title, profile(req), 'mangadex'));
  app.get('/api/manga/metadata/mangabaka-title', { schema: { querystring: titleQuery } },
    async req => manga.koreanTitle(query(req).title, profile(req), 'mangabaka'));
  const browseFields = { page: pageQuery, q: { type: 'string', maxLength: 200, default: '' }, mode: { type: 'string', enum: ['popular', 'latest'], default: 'popular' } };
  app.get('/api/manga/sources/:id/browse', { schema: { params: idParams(), querystring: object(browseFields) } },
    async req => manga.browse(params(req).id, profile(req), query(req).page ?? 1, query(req).q ?? '', query(req).mode ?? 'popular'));
  app.post('/api/manga/sources/:id/browse', { schema: { params: idParams(), body: object({ ...browseFields, selection: browseSelection }, ['selection']) } },
    async req => {
      const { page = 1, q = '', mode = 'popular', selection } = req.body as { page?: number; q?: string; mode?: 'popular' | 'latest'; selection: BrowseSelection };
      return manga.browse(params(req).id, profile(req), page, q, mode, selection);
    });
  app.get('/api/manga/works/:id', { schema: { params: idParams() } }, async req => manga.detail(params(req).id, profile(req)));
  app.get('/api/manga/chapters/:id/pages', { schema: { params: idParams() } }, async req => manga.pages(params(req).id, profile(req)));
}
