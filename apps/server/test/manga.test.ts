import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { parseRepository } from '../src/sources/extensions/index.js';

const fixtureCode = `class DefaultExtension extends MProvider {
  async getPopular(){return {list:[{name:'Manga Fixture',link:'/work'}],hasNextPage:false};}
  async getDetail(){return {name:'Manga Fixture',chapters:[{name:'2화',url:'/2'},{name:'1화',url:'/1'}]};}
  getHeaders(){return {Referer:'https://example.com/work'};}
  async getPageList(){return ['https://images.example.com/page.png'];}
}`;

test('manga uses the existing page runtime and image proxy without entering the anime catalog', async () => {
  const root = path.resolve(`.manga-test-${randomUUID()}`);
  await mkdir(root);
  const { app, db, sources } = await buildApp({ dataDir: root, mediaRoot: root, webDir: path.join(root, 'web'), requireAccount: false }, false);
  try {
    const created = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'reader' } });
    assert.equal(created.statusCode, 201, created.body);
    const profileId = created.json().id;
    const headers = { 'x-moa-profile': profileId };
    const entry = parseRepository([{ id: 'fixture', name: 'Manga Fixture', version: '1', itemType: 0, sourceCodeLanguage: 1,
      baseUrl: 'https://example.com', sourceCodeUrl: 'https://example.com/source.js' }])[0];
    const sourceId = 'manga-fixture';
    db.run('INSERT INTO source_entries(id,repository,entry,installed_entry,code,enabled) VALUES(?,?,?,?,?,1)',
      sourceId, 'https://example.com/index.json', JSON.stringify(entry), JSON.stringify(entry), fixtureCode);
    assert.equal(sources.list()[0].contentKind, 'manga');
    const get = async (url: string) => {
      const reply = await app.inject({ url, headers });
      assert.equal(reply.statusCode, 200, reply.body);
      return reply.json();
    };
    const browse = await get(`/api/manga/sources/${sourceId}/browse`);
    assert.equal(browse.items[0].title, 'Manga Fixture');
    assert.equal(db.get('SELECT count(*) AS n FROM media')?.n, 0);
    const work = await get(`/api/manga/works/${browse.items[0].id}`);
    assert.deepEqual(work.chapters.map((c: { title: string }) => c.title), ['1화', '2화']);
    const pathToPages = `/api/manga/chapters/${work.chapters[0].id}/pages`;
    const pages = await get(pathToPages);
    assert.equal(pages.nextId, work.chapters[1].id);
    assert.match(pages.images[0], /^\/api\/images\/source-/);
    await sources.imageContent(pages.images[0].split('/').pop(), async input => {
      assert.equal(input.url, 'https://images.example.com/page.png');
      assert.equal(input.headers?.Referer, 'https://example.com/work');
      return { bytes: Buffer.from('fixture'), headers: {}, statusCode: 200, contentType: 'image/png' };
    });
    assert.equal((await app.inject({ url: `/api/sources/${sourceId}/browse`, headers })).statusCode, 400);
    db.run('UPDATE profiles SET kids=1 WHERE id=?', profileId);
    assert.equal((await app.inject({ url: pathToPages, headers })).statusCode, 403);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
