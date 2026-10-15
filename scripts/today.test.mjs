import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishingDay, buildToday, writeToday, runOnce } from './publish.mjs';

const put = async (dir, file, value) => {
  const target = path.join(dir, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value));
};
const temp = async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dawn-today-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('scheduled backlog uses slot day, manual uses postedAt in Korea, legacy fallback', () => {
  const id = '2026-10-14-pm';
  const record = { slot: '2026-10-19T20:00:00+09:00', postedAt: '2026-10-20T16:00:00Z' };
  assert.equal(publishingDay(record, {}, id), '2026-10-19');
  assert.equal(publishingDay({ ...record, manual: true }, {}, id), '2026-10-21');
  assert.equal(publishingDay({ ...record, how: 'manual' }, {}, id), '2026-10-21');
  assert.equal(publishingDay({ postedAt: '2026-10-19T16:00:00Z' }, {}, id), '2026-10-20');
  assert.equal(publishingDay({}, { slot: record.slot }, id), '2026-10-19');
  assert.equal(publishingDay({}, {}, id), '2026-10-14');
});

test('existing history day survives; new shifted/manual items use actual days; read does not write', async t => {
  const dir = await temp(t);
  const history = { items: [{ id: '2026-10-13-pm', day: '2026-10-13' }] };
  await put(dir, 'state/today.json', history);
  for (const [id, record] of [
    ['2026-10-13-pm', { slot: '2026-10-19T20:00:00+09:00' }],
    ['2026-10-14-pm', { slot: '2026-10-19T20:00:00+09:00' }],
    ['2026-10-12-pm', { slot: '2026-10-12T20:00:00+09:00', manual: true, postedAt: '2026-10-20T16:00:00Z' }],
  ]) {
    await put(dir, `state/posted/${id}.json`, record);
    await put(dir, `queue/${id}.json`, { series: 'history', title: id, link: 'https://history.matto.kr/' });
  }
  const built = await buildToday(dir);
  assert.deepEqual(built.items.map(i => [i.id, i.day]), [
    ['2026-10-12-pm', '2026-10-21'], ['2026-10-14-pm', '2026-10-19'], ['2026-10-13-pm', '2026-10-13'],
  ]);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'state/today.json'), 'utf8')), history);
  await writeToday(dir);
  assert.deepEqual(await buildToday(dir), built);
});

test('manual choice is recorded using fake Instagram calls only', async t => {
  const dir = await temp(t), id = '2026-10-14-pm';
  await put(dir, `queue/${id}.json`, { id, series: 'history', slot: '2026-10-19T20:00:00+09:00', text: 'test', cards: [{ url: 'fake' }] });
  const api = { get: async node => node.endsWith('/media') ? { data: [] } : { status_code: 'FINISHED', permalink: 'fake' }, post: async () => ({ id: 'fake' }) };
  const result = await runOnce({ dir, id, api, github: { issue: () => { throw new Error('unexpected alert'); } }, now: () => new Date('2026-10-20T16:00:00Z'), sleep: async () => {} });
  assert.equal(result.posted, id);
  const record = JSON.parse(await readFile(path.join(dir, `state/posted/${id}.json`), 'utf8'));
  assert.equal(record.manual, true);
  assert.equal((await buildToday(dir)).items[0].day, '2026-10-21');
});
