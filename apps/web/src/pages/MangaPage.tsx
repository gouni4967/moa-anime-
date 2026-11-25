import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, ChevronRight } from 'lucide-react';
import type { BrowseSelection, MangaCard, MangaDetail, MangaPages, Page, VideoSource } from '@moa/shared';
import { Button, ButtonLink, EmptyState, ScrollLoader, SegmentedControl } from '../components/ui';
import { RowShell } from '../components/Row';
import { useProfiles } from '../api/queries';
import { SourceFilters, useSourceFilters } from '../features/sources/SourceFilters';
import { parseSelection } from '../features/sources/source-browse';
import { api, ApiError, currentProfileId } from '../lib/api';
import { findKoreanMangaIntroduction, findKoreanMangaTitle, koreanMangaChapterTitle, mangaLookupTitle } from '../lib/manga-korean';
import { useSources } from './SourcesPage';
import '../styles/manga.scss';

function MangaError({ error, retry }: { error: unknown; retry: () => void }) {
  if (error instanceof ApiError && error.code === 'manga-unrated') return <EmptyState title="이 프로필에서는 만화를 읽을 수 없어요" />;
  return <EmptyState title="만화를 불러오지 못했습니다" action={<Button onClick={retry}>다시 시도</Button>} />;
}

const koreanMetadataCacheTime = 60 * 60_000;

function useKoreanMangaTitle(sourceTitle: string, enabled = true) {
  const title = mangaLookupTitle(sourceTitle);
  return useQuery({
    queryKey: ['manga-korean-title', title.toLowerCase()],
    enabled: enabled && !!title,
    retry: false,
    staleTime: koreanMetadataCacheTime,
    gcTime: koreanMetadataCacheTime,
    queryFn: ({ signal }) => findKoreanMangaTitle(title, signal),
  });
}

function MangaBrowseCard({ item }: { item: MangaCard }) {
  const card = useRef<HTMLAnchorElement>(null);
  const [seen, setSeen] = useState(false);
  const { data: korean } = useKoreanMangaTitle(item.title, seen);

  useEffect(() => {
    const element = card.current;
    if (!element || seen || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      setSeen(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);

  return <Link ref={card} className="manga-card" to={`/manga/works/${item.id}`}>
    {item.poster && <img src={item.poster} alt="" loading="lazy" />}
    <span title={korean && korean.title !== item.title ? item.title : undefined}>
      {korean?.title ?? item.title}
      {korean?.mangaBakaUrl && <small className="source-muted"> · MangaBaka</small>}
    </span>
  </Link>;
}

type MangaSort = 'popular' | 'latest';

export function useMangaSources() {
  const sources = useSources();
  const profiles = useProfiles();
  const profile = profiles.data?.find(item => item.id === currentProfileId());
  return {
    pending: sources.isPending || profiles.isPending,
    error: sources.isError || profiles.isError,
    sources: profile && !profile.kids ? (sources.data ?? []).filter(source => source.enabled && source.contentKind === 'manga') : [],
  };
}

function useMangaBrowse(id: string, term: string, sort: MangaSort, enabled = true, selection?: BrowseSelection) {
  const filters = selection?.filters.length ? selection : undefined;
  return useInfiniteQuery({
    queryKey: ['manga-browse', currentProfileId(), id, term, term || filters ? 'search' : sort, filters],
    enabled, initialPageParam: 1, retry: false, staleTime: 60_000,
    queryFn: ({ pageParam, signal }) => {
      const endpoint = `/manga/sources/${encodeURIComponent(id)}/browse`;
      if (filters) return api<Page<MangaCard>>(endpoint, {
        method: 'POST', body: { page: pageParam, q: term, mode: sort, selection: filters }, signal,
      });
      const query = new URLSearchParams({ page: String(pageParam), q: term, mode: sort });
      return api<Page<MangaCard>>(`${endpoint}?${query}`, { signal });
    },
    getNextPageParam: page => page.hasNextPage ? page.page + 1 : undefined,
  });
}

function LatestMangaRow({ source, showFallback }: { source: VideoSource; showFallback: boolean }) {
  const schema = useSourceFilters(source.id);
  const latest = schema.data?.availableModes.includes('latest') ?? false;
  const result = useMangaBrowse(source.id, '', 'latest', latest);
  const items = result.data?.pages[0]?.items.slice(0, 12) ?? [];
  const browse = `/manga/sources/${encodeURIComponent(source.id)}`;
  if (!items.length) {
    return showFallback ? <section className="row">
      <h2>{source.name}</h2>
      {(schema.isPending || result.isLoading) && <p role="status">최근 업데이트를 불러오는 중…</p>}
      <ButtonLink to={browse}>작품 둘러보기</ButtonLink>
    </section> : null;
  }
  return <RowShell id={`manga-latest-${source.id}`} title={`최근 업데이트 만화 · ${source.name}`} layout="poster" count={items.length}
    more={<Link className="row-more" to={`${browse}?sort=latest`}>모두 보기<ChevronRight size={16} /></Link>}>
    {items.map(item => <MangaBrowseCard key={item.id} item={item} />)}
  </RowShell>;
}

export function LatestMangaRows({ showFallback = false }: { showFallback?: boolean }) {
  const state = useMangaSources();
  if (showFallback && !state.sources.length) {
    if (state.pending) return <p role="status">만화 소스를 불러오는 중…</p>;
    return <EmptyState title={state.error ? '만화 소스를 불러오지 못했어요' : '표시할 만화 소스가 없어요'} />;
  }
  return <>{state.sources.map(source => <LatestMangaRow key={source.id} source={source} showFallback={showFallback} />)}</>;
}

export function MangaHomePage() {
  return <div className="page-pad">
    <header className="page-head"><h1>만화</h1></header>
    <LatestMangaRows showFallback />
  </div>;
}

export function MangaBrowsePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const term = params.get('q') ?? '';
  const [input, setInput] = useState(term);
  const sources = useSources();
  const source = sources.data?.find(s => s.id === id && s.contentKind === 'manga');
  const sort = params.get('sort') === 'latest' ? 'latest' : 'popular';
  const rawFilters = params.get('filters');
  const selection = parseSelection(rawFilters);
  const [draft, setDraft] = useState(selection);
  useEffect(() => { setInput(term); }, [term, id]);
  useEffect(() => { setDraft(parseSelection(rawFilters)); }, [rawFilters, id]);
  const setFilters = (value?: BrowseSelection) => {
    const next = new URLSearchParams(params);
    if (value?.filters.length) next.set('filters', JSON.stringify(value)); else next.delete('filters');
    setParams(next);
  };
  const result = useMangaBrowse(id, term, sort, Boolean(source?.enabled), selection);
  const capabilities = useSourceFilters(source?.enabled ? id : '');
  const items = [...new Map(result.data?.pages.flatMap(page => page.items).map(item => [item.id, item]) ?? []).values()];
  return <div className="page-pad">
    <header className="page-head"><h1>{source?.name ?? '만화'}</h1></header>
    <form className="source-search-form" role="search" onSubmit={event => { event.preventDefault(); const next = new URLSearchParams(params); if (input.trim()) next.set('q', input.trim()); else next.delete('q'); setParams(next); }}>
      <label className="field"><span>만화 제목</span><input type="search" value={input} maxLength={200} onChange={event => setInput(event.target.value)} /></label>
      <Button type="submit">검색</Button>
    </form>
    {!term && !selection?.filters.length && capabilities.data?.availableModes.includes('latest') && <SegmentedControl label="작품 정렬" value={sort} options={[
      { value: 'popular', label: '인기순' }, { value: 'latest', label: '최신 업데이트순' },
    ]} onChange={value => {
      const next = new URLSearchParams(params);
      if (value === 'latest') next.set('sort', value); else next.delete('sort');
      setParams(next);
    }} />}
    {!!capabilities.data?.filters.length && <details className="browse-filters">
      <summary>장르 및 필터{selection?.filters.length ? ' · 적용 중' : ''}</summary>
      <SourceFilters schema={capabilities.data} value={draft} onChange={setDraft}
        actions={<Button variant="primary" onClick={() => setFilters(draft)}>조건 적용</Button>} />
    </details>}
    {rawFilters && (!selection || result.error instanceof ApiError && result.error.code === 'source-filters-changed') &&
      <p role="alert">필터가 변경됐어요. <button className="text-btn" onClick={() => setFilters()}>조건 초기화</button></p>}
    {sources.isSuccess && !source?.enabled && <EmptyState title="사용할 수 없는 만화 소스입니다" />}
    {result.isLoading && <p role="status">작품 목록을 불러오는 중…</p>}
    {result.isError && <MangaError error={result.error} retry={() => void (result.isFetchNextPageError ? result.fetchNextPage() : result.refetch())} />}
    {result.isSuccess && !items.length && <EmptyState title="표시할 작품이 없습니다" />}
    <div className="grid">{items.map(item => <MangaBrowseCard key={item.id} item={item} />)}</div>
    <ScrollLoader hasMore={result.hasNextPage} loading={result.isFetching} failed={result.isError} onLoad={result.fetchNextPage} />
  </div>;
}

function MangaCover({ poster }: { poster?: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="manga-work-cover">
    {poster && !failed ? <img src={poster} alt="" onError={() => setFailed(true)} /> : <BookOpen size={34} aria-hidden />}
  </div>;
}

function MangaWorkContent({ work }: { work: MangaDetail }) {
  const [order, setOrder] = useState<'oldest' | 'latest'>('oldest');
  const { data: korean } = useKoreanMangaTitle(work.title);
  const article = korean?.article ?? '';
  const { data: introduction } = useQuery({
    queryKey: ['manga-korean-introduction', article], enabled: !!article,
    retry: false, staleTime: koreanMetadataCacheTime,
    queryFn: ({ signal }) => findKoreanMangaIntroduction(article, signal),
  });
  const firstChapter = work.chapters[0];
  const chapters = order === 'latest' ? [...work.chapters].reverse() : work.chapters;

  return <>
    <ButtonLink to={`/manga/sources/${encodeURIComponent(work.sourceId)}`} variant="ghost" icon={<ArrowLeft size={16} />}>
      만화 목록
    </ButtonLink>
    <header className="manga-work-hero">
      <MangaCover key={work.poster} poster={work.poster} />
      <div className="manga-work-meta">
        <h1>{korean?.title ?? work.title}</h1>
        {korean?.mangaDexUrl && <small><a href={korean.mangaDexUrl} target="_blank" rel="noreferrer">제목 출처 · MangaDex</a></small>}
        {korean?.mangaBakaUrl && <small><a href={korean.mangaBakaUrl} target="_blank" rel="noreferrer">제목 출처 · MangaBaka</a> · <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noreferrer">CC BY-NC-SA 4.0</a></small>}
        {work.author && <p className="manga-work-author">{work.author}</p>}
        {firstChapter && <ButtonLink
          to={`/manga/read/${firstChapter.id}`}
          variant="primary"
          icon={<BookOpen size={17} />}
        >첫 회차 읽기</ButtonLink>}
      </div>
    </header>
    {introduction?.text && <section className="manga-synopsis" aria-labelledby="manga-introduction">
      <h2 id="manga-introduction">작품 소개</h2>
      <p>{introduction.text}</p>
      <small><a href={introduction.url} target="_blank" rel="noreferrer">한국어 위키백과</a> · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a></small>
      {work.description && <details><summary>원문 줄거리</summary><p>{work.description}</p></details>}
    </section>}
    {!introduction?.text && work.description && <section className="manga-synopsis" aria-labelledby="manga-synopsis">
      <h2 id="manga-synopsis">줄거리</h2>
      <p>{work.description}</p>
    </section>}
    <section className="manga-chapters" aria-labelledby="manga-chapters">
      <div className="manga-chapters-header">
        <h2 id="manga-chapters">회차 <small>{work.chapters.length}개</small></h2>
        {work.chapters.length > 1 && <SegmentedControl label="회차 정렬" value={order} onChange={setOrder}
          options={[{ value: 'oldest', label: '오래된순' }, { value: 'latest', label: '최신순' }]} />}
      </div>
      {chapters.length ? <ul className="manga-chapter-list">
        {chapters.map(chapter => <li key={chapter.id}>
          <Link to={`/manga/read/${chapter.id}`}>
            <span>{koreanMangaChapterTitle(chapter.title)}</span><ChevronRight size={18} aria-hidden />
          </Link>
        </li>)}
      </ul> : <EmptyState title="읽을 수 있는 회차가 없습니다" />}
    </section>
  </>;
}

export function MangaWorkPage() {
  const { id = '' } = useParams();
  const result = useQuery({ queryKey: ['manga-work', currentProfileId(), id], retry: false,
    queryFn: ({ signal }) => api<MangaDetail>(`/manga/works/${encodeURIComponent(id)}`, { signal }) });
  return <div className="page-pad narrow manga-work">
    {result.isPending && <p role="status">작품을 불러오는 중…</p>}
    {result.isError && <MangaError error={result.error} retry={() => void result.refetch()} />}
    {result.data && <MangaWorkContent key={id} work={result.data} />}
  </div>;
}

export function MangaReaderPage() {
  const { id = '' } = useParams();
  const result = useQuery({ queryKey: ['manga-pages', currentProfileId(), id], retry: false,
    queryFn: ({ signal }) => api<MangaPages>(`/manga/chapters/${encodeURIComponent(id)}/pages`, { signal }) });
  const data = result.data;
  return <div className="page-pad manga-reader">
    <header className="page-head"><h1>{data?.title ?? '만화 읽기'}</h1>{data && <ButtonLink to={`/manga/works/${data.workId}`}>회차 목록</ButtonLink>}</header>
    {result.isPending && <p role="status">페이지를 불러오는 중…</p>}
    {result.isError && <MangaError error={result.error} retry={() => void result.refetch()} />}
    {data && <><div className="manga-pages" key={id}>{data.images.map((src, index) =>
      <img key={`${index}:${src}`} src={src} alt={`${index + 1}페이지`} loading={index === 0 ? 'eager' : 'lazy'} />)}</div>
      <nav aria-label="만화 회차 이동" className="source-toolbar">
        {data.previousId && <ButtonLink to={`/manga/read/${data.previousId}`}>이전 회차</ButtonLink>}
        {data.nextId && <ButtonLink to={`/manga/read/${data.nextId}`}>다음 회차</ButtonLink>}
      </nav>
    </>}
  </div>;
}
