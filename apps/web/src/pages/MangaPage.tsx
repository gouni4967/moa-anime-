import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, ChevronRight } from 'lucide-react';
import type { MangaCard, MangaDetail, MangaPages, Page } from '@moa/shared';
import { Button, ButtonLink, EmptyState, ScrollLoader, SegmentedControl } from '../components/ui';
import { api, ApiError, currentProfileId } from '../lib/api';
import { findKoreanMangaInfo, koreanMangaChapterTitle } from '../lib/manga-korean';
import { useSources } from './SourcesPage';
import '../styles/manga.scss';

function MangaError({ error, retry }: { error: unknown; retry: () => void }) {
  if (error instanceof ApiError && error.code === 'manga-unrated') return <EmptyState title="이 프로필에서는 만화를 읽을 수 없어요" />;
  return <EmptyState title="만화를 불러오지 못했습니다" action={<Button onClick={retry}>다시 시도</Button>} />;
}

export function MangaBrowsePage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const term = params.get('q') ?? '';
  const [input, setInput] = useState(term);
  const source = useSources().data?.find(s => s.id === id && s.contentKind === 'manga');
  const result = useInfiniteQuery({
    queryKey: ['manga-browse', currentProfileId(), id, term], initialPageParam: 1, retry: false,
    queryFn: ({ pageParam, signal }) => api<Page<MangaCard>>(`/manga/sources/${encodeURIComponent(id)}/browse?page=${pageParam}&q=${encodeURIComponent(term)}`, { signal }),
    getNextPageParam: page => page.hasNextPage ? page.page + 1 : undefined,
  });
  const items = [...new Map(result.data?.pages.flatMap(page => page.items).map(item => [item.id, item]) ?? []).values()];
  return <div className="page-pad">
    <header className="page-head"><h1>{source?.name ?? '만화'}</h1></header>
    <form className="source-search-form" role="search" onSubmit={event => { event.preventDefault(); setParams(input.trim() ? { q: input.trim() } : {}); }}>
      <label className="field"><span>만화 제목</span><input type="search" value={input} maxLength={200} onChange={event => setInput(event.target.value)} /></label>
      <Button type="submit">검색</Button>
    </form>
    {result.isPending && <p role="status">작품 목록을 불러오는 중…</p>}
    {result.isError && <MangaError error={result.error} retry={() => void (result.isFetchNextPageError ? result.fetchNextPage() : result.refetch())} />}
    {result.isSuccess && !items.length && <EmptyState title="표시할 작품이 없습니다" />}
    <div className="grid">{items.map(item => <Link key={item.id} className="manga-card" to={`/manga/works/${item.id}`}>
      {item.poster && <img src={item.poster} alt="" loading="lazy" />}<span>{item.title}</span>
    </Link>)}</div>
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
  const { data: korean } = useQuery({
    queryKey: ['manga-korean-info', work.title], retry: false, staleTime: 60 * 60 * 1000,
    queryFn: ({ signal }) => findKoreanMangaInfo(work.title, signal),
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
        {work.author && <p className="manga-work-author">{work.author}</p>}
        {firstChapter && <ButtonLink
          to={`/manga/read/${firstChapter.id}`}
          variant="primary"
          icon={<BookOpen size={17} />}
        >첫 회차 읽기</ButtonLink>}
      </div>
    </header>
    {korean?.introduction && <section className="manga-synopsis" aria-labelledby="manga-introduction">
      <h2 id="manga-introduction">작품 소개</h2>
      <p>{korean.introduction}</p>
      <small><a href={korean.articleUrl} target="_blank" rel="noreferrer">한국어 위키백과</a> · <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a></small>
      {work.description && <details><summary>원문 줄거리</summary><p>{work.description}</p></details>}
    </section>}
    {!korean?.introduction && work.description && <section className="manga-synopsis" aria-labelledby="manga-synopsis">
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
