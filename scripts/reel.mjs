import { readFile, writeFile, readdir, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IG, IG_USER, hide, pickPost } from './publish.mjs';
import { pushReelState } from './reel-git.mjs';
const WINDOW = 90 * 60_000, RUN_LIMIT = 10 * 60_000;
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export function reelApi(token, fetchImpl = fetch) {
  const call = async (method, node, params = {}, options = {}) => {
    const url = new URL(`${IG}/${node}`);
    const init = { method, signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, Math.floor(options.timeoutMs ?? 30_000)))) };
    if (method === 'GET') for (const [k, v] of Object.entries({ ...params, access_token: token })) url.searchParams.set(k, v);
    else init.body = new URLSearchParams({ ...params, access_token: token });
    try {
      const r = await fetchImpl(url, init), body = await r.json();
      if (!r.ok || body.error) throw new Error(`인스타 응답 ${r.status}: ${body.error?.message ?? '응답 오류'}`);
      return body;
    } catch (e) { throw new Error(hide(e.message, token)); }
  };
  return { get: (node, p, options) => call('GET', node, p, options), post: (node, p) => call('POST', node, p) };
}
export function reelCardsMatch(entry, reel) {
  const names = entry.cards.map(c => new URL(c.url).pathname.match(/\/(cards\/[^/]+\/[^/]+)$/)?.[1]);
  return JSON.stringify(names) === JSON.stringify(reel.cards);
}
export async function recoverPublished(api, entry) {
  let after;
  const seen = new Set();
  do {
    const { data = [], paging } = await api.get(`${IG_USER}/media`, { fields: 'id,caption,permalink,timestamp,media_product_type', limit: '100', ...(after ? { after } : {}) });
    const hit = data.find(m => m.media_product_type === 'REELS' && norm(m.caption) === norm(entry.text));
    if (hit) return hit;
    after = paging?.next ? paging.cursors?.after : null;
    if (seen.has(after)) return null;
    seen.add(after);
  } while (after);
  return null;
}
// Persistence and checkpoint are injected; tests never contact Instagram or a remote repository.
export async function processReel({ entry, reel, state = null, api, github, save, checkpoint, now, sleep, dry = false, token = '', limit = RUN_LIMIT }) {
  const began = now().getTime(), deadline = began + limit;
  let record = { id: entry.id, slot: entry.slot, status: 'started', retries: 0, ...(state ?? {}) };
  const summary = () => ({ id: entry.id, status: record.status, containerStatus: record.containerStatus ?? null, elapsedSeconds: (now().getTime() - began) / 1000, error: record.error ?? record.lastReadError ?? null });
  const persist = async () => { if (!dry) await save(record); };
  const alert = async () => {
    if (dry || record.alerted || (!record.alertError && !['failed', 'unknown'].includes(record.status))) return;
    try {
      await github.issue(`[인스타 릴] ${entry.id} ${record.status}`, hide(`- 예정 시각: ${entry.slot}\n- 상태: ${record.status}\n- 까닭: ${record.error ?? '게시 결과를 찾지 못했습니다'}\n- 그릇 번호: ${record.creationId ?? '없음'}`, token));
      record.alerted = true; delete record.alertError;
    } catch (e) { record.alertError = hide(e.message, token); }
    await persist();
  };
  const fail = async error => { record.status = 'failed'; record.error = error; await persist(); await alert(); };
  try {
    if (record.alertError) await alert();
    if (!dry && ['posted', 'failed', 'unknown'].includes(record.status)) { await alert(); return summary(); }
    if (!dry && now().getTime() > Date.parse(entry.slot) + WINDOW) { await fail('시간 창 지남'); return summary(); }
    if (!reelCardsMatch(entry, reel)) { await fail('릴과 카드 대기열의 그림 이름이 다릅니다'); return summary(); }
    if (!dry && record.creationId && record.sha256 && record.sha256 !== reel.sha256) { await fail('기존 그릇과 릴 목록의 영상 해시가 다릅니다'); return summary(); }
    if (!api) throw new Error('IG_TOKEN이 없습니다');
    if (dry) record = { id: entry.id, status: 'dry', retries: 0 };
    const create = async () => {
      const { id } = await api.post(`${IG_USER}/media`, { media_type: 'REELS', video_url: reel.url, caption: entry.text, share_to_feed: 'false', thumb_offset: String(reel.thumbOffsetMs) });
      if (!id) throw new Error('그릇 번호가 없습니다');
      record.creationId = id; record.status = dry ? 'dry' : 'started';
      record.startedAt = now().toISOString(); record.sha256 = reel.sha256;
      await persist();
    };
    if (!record.creationId) await create();
    // Repeat the checkpoint on resume too: a prior process may have stopped before push.
    if (!dry) await checkpoint(record);
    if (!dry && now().getTime() > Date.parse(entry.slot) + WINDOW) { await fail('시간 창 지남'); return summary(); }
    while (now().getTime() < deadline) {
      if (!dry && now().getTime() > Date.parse(entry.slot) + WINDOW) { await fail('시간 창 지남'); break; }
      let remote;
      try { remote = await api.get(record.creationId, { fields: 'status_code,status' }, { timeoutMs: deadline - now().getTime() }); }
      catch (e) { record.lastReadError = hide(e.message, token); await persist(); break; }
      const status = remote.status_code;
      delete record.lastReadError;
      record.containerStatus = status; await persist();
      if (now().getTime() > deadline) break;
      if (status === 'FINISHED') {
        if (dry) break;
        if (now().getTime() > Date.parse(entry.slot) + WINDOW) { await fail('시간 창 지남'); break; }
        record.status = 'publishing'; await persist(); await checkpoint(record);
        if (now().getTime() > Date.parse(entry.slot) + WINDOW) { await fail('시간 창 지남'); break; }
        const { id } = await api.post(`${IG_USER}/media_publish`, { creation_id: record.creationId });
        if (!id) throw new Error('게시 번호가 없습니다. 다음 실행에서 그릇 상태를 확인합니다');
        record.status = 'posted'; record.mediaId = id; record.postedAt = now().toISOString(); record.permalink = null;
        delete record.error;
        try { record.permalink = (await api.get(id, { fields: 'permalink' })).permalink ?? null; }
        catch (e) { record.permalinkError = hide(e.message, token); }
        await persist(); break;
      }
      if (status === 'PUBLISHED') {
        if (dry) break;
        const hit = await recoverPublished(api, entry);
        if (hit) { record.status = 'posted'; record.mediaId = hit.id; record.permalink = hit.permalink ?? null; record.postedAt = hit.timestamp ?? now().toISOString(); delete record.error; }
        else { record.status = 'unknown'; record.error = '게시된 릴을 내 게시물 목록에서 찾지 못했습니다'; }
        await persist(); await alert(); break;
      }
      if (status === 'ERROR') { await fail(`그릇 ERROR: ${remote.status ?? ''}`); break; }
      if (status === 'EXPIRED') {
        if (!dry && record.retries < 1 && now().getTime() <= Date.parse(entry.slot) + WINDOW && now().getTime() < deadline) {
          record.retries++; await create(); await checkpoint(record); continue;
        }
        await fail('그릇 EXPIRED'); break;
      }
      if (status !== 'IN_PROGRESS') { record.lastReadError = `알 수 없는 그릇 상태: ${status}`; await persist(); break; }
      if (now().getTime() + 30_000 > deadline) break;
      await sleep(30_000);
    }
    if (!dry && !['posted', 'failed', 'unknown'].includes(record.status) && now().getTime() > Date.parse(entry.slot) + WINDOW) await fail('시간 창 지남');
  } catch (e) {
    // Keep the container after an uncertain publish or checkpoint failure. Never recreate it.
    record.error = hide(e.message, token);
    if (record.creationId && !['posted', 'failed', 'unknown'].includes(record.status)) record.status = dry ? 'dry' : 'started';
    else if (!record.creationId) record.status = 'failed';
    try { await persist(); if (record.status === 'started') {
      // Alert delivery failures remain retryable without making the container terminal.
      if (!record.alerted && !dry) {
        try { await github.issue(`[인스타 릴] ${entry.id} 처리 중 오류`, record.error); record.alerted = true; }
        catch (issueError) { record.alertError = hide(issueError.message, token); }
        await persist();
      }
    } else await alert(); } catch (saveError) { console.error(hide(`릴 기록 저장 실패: ${saveError.message}`, token)); }
  }
  return summary();
}
const json = async file => JSON.parse(await readFile(file, 'utf8'));
export async function runReels({ dir, api, github, now, sleep, checkpoint = () => pushReelState(dir), enabled = false, paused = false, cardPushSucceeded = true, dry = false, id = null, token = '' }) {
  if (paused || (!dry && (!enabled || !cardPushSucceeded))) return [];
  const qDir = path.join(dir, 'queue'), entries = [];
  if (existsSync(qDir)) for (const file of (await readdir(qDir)).filter(f => /^\d{4}-\d{2}-\d{2}-(am|pm)\.json$/.test(f))) entries.push(await json(path.join(qDir, file)));
  const lists = new Map(), results = [];
  let selected = id;
  if (dry && !id) {
    const posted = new Set(existsSync(path.join(dir, 'state/posted')) ? (await readdir(path.join(dir, 'state/posted'))).map(f => f.replace(/\.json$/, '')) : []);
    selected = pickPost(entries, posted, now())?.id;
    if (!selected) return [];
  }
  for (const entry of entries.sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot))) {
    if ((dry || id) && entry.id !== selected) continue;
    const month = entry.id.slice(0, 7), listFile = path.join(dir, 'reels', `${month}.json`);
    if (!lists.has(month)) lists.set(month, existsSync(listFile) ? await json(listFile) : {});
    const reel = lists.get(month)[entry.id];
    if (!reel) continue;
    if (!dry && !existsSync(path.join(dir, 'state/posted', `${entry.id}.json`))) continue;
    const file = path.join(dir, 'state/reels', `${entry.id}.json`);
    const state = existsSync(file) ? await json(file) : null;
    const save = async record => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(record, null, 2) + '\n'); };
    results.push(await processReel({ entry, reel, state, api, github, now, sleep, dry, save, checkpoint, token }));
  }
  return results;
}
async function main() {
  const args = process.argv.slice(2), token = process.env.IG_TOKEN ?? '';
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const github = { issue: async (title, body) => {
    const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`, { method: 'POST', signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'content-type': 'application/json', accept: 'application/vnd.github+json' }, body: JSON.stringify({ title, body }) });
    if (!r.ok) throw new Error(`알림 이슈 실패: ${r.status}`);
  } };
  try {
    const result = await runReels({ dir, api: token ? reelApi(token) : null, github, now: () => new Date(), sleep: ms => new Promise(r => setTimeout(r, ms)), enabled: process.env.REELS_ENABLED === '1', paused: process.env.PAUSE === '1', dry: args.includes('--dry'), id: args.includes('--id') ? args[args.indexOf('--id') + 1] : null, token });
    console.log(JSON.stringify(result));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n릴 확인 결과\n\n${result.map(r => `- ${r.id}: ${r.containerStatus ?? r.status}, ${r.elapsedSeconds}초, 오류: ${r.error ?? '없음'}`).join('\n') || '대상 없음'}\n`);
  } catch (e) { console.error(hide(e.message, token)); if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n릴 오류: ${hide(e.message, token)}\n`); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => console.error(hide(e.message, process.env.IG_TOKEN ?? '')));
