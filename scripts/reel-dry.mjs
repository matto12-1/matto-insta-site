// Card dry workflow entry: no state writes, missed alerts or today-list refresh.
import { readFile, readdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickPost, publishOne, igApi, hide } from './publish.mjs';
export async function dryCard({ dir, api, now, sleep, id = null }) {
  const entries = [];
  for (const f of (await readdir(path.join(dir, 'queue'))).filter(f => /^\d{4}-\d{2}-\d{2}-(am|pm)\.json$/.test(f))) entries.push(JSON.parse(await readFile(path.join(dir, 'queue', f), 'utf8')));
  const postedDir = path.join(dir, 'state/posted');
  const posted = new Set(existsSync(postedDir) ? (await readdir(postedDir)).map(f => f.replace(/\.json$/, '')) : []);
  const entry = id ? entries.find(e => e.id === id) : pickPost(entries, posted, now());
  if (!entry) return { status: 'no-target' };
  const started = now().getTime();
  try {
    if (!api) throw new Error('IG_TOKEN이 없습니다');
    const r = await publishOne({ entry, api, now, sleep, dry: true, wait: false });
    return { ...r, id: entry.id, containerStatus: r.creationId ? 'FINISHED' : r.status, elapsedSeconds: (now().getTime() - started) / 1000, error: null };
  } catch (e) { return { id: entry.id, status: 'error', error: e.message, elapsedSeconds: (now().getTime() - started) / 1000 }; }
}
async function main() {
  const args = process.argv.slice(2), token = process.env.IG_TOKEN ?? '';
  const result = await dryCard({ dir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), api: token ? igApi(token) : null, now: () => new Date(), sleep: ms => new Promise(r => setTimeout(r, ms)), id: args.includes('--id') ? args[args.indexOf('--id') + 1] : null });
  const text = hide(JSON.stringify(result), token); console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n카드 그릇 확인\n\n${text}\n`);
  if (result.status === 'error') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(hide(e.message, process.env.IG_TOKEN ?? '')); process.exitCode = 1; });
