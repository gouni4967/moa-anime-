import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { MangaCard, MangaDetail, MangaPages, Page } from '@moa/shared';
import { Button, ButtonLink, EmptyState, ScrollLoader } from '../components/ui';
import { api, ApiError, currentProfileId } from '../lib/api';
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

export function MangaWorkPage() {
  const { id = '' } = useParams();
  const result = useQuery({ queryKey: ['manga-work', currentProfileId(), id], retry: false,
    queryFn: ({ signal }) => api<MangaDetail>(`/manga/works/${encodeURIComponent(id)}`, { signal }) });
  return <div className="page-pad narrow">
    <header className="page-head"><h1>{result.data?.title ?? '만화 회차'}</h1></header>
    {result.isPending && <p role="status">회차를 불러오는 중…</p>}
    {result.isError && <MangaError error={result.error} retry={() => void result.refetch()} />}
    {result.data && <>
      {result.data.description && <p>{result.data.description}</p>}
      {result.data.chapters.length ? <ol>{result.data.chapters.map(chapter => <li key={chapter.id}><Link to={`/manga/read/${chapter.id}`}>{chapter.title}</Link></li>)}</ol> : <EmptyState title="읽을 수 있는 회차가 없습니다" />}
    </>}
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
