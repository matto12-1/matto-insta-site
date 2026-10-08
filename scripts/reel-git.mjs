import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
// Same identity, rebase-on-conflict and five attempts as workflow record steps.
export async function pushReelState(dir, run = exec) {
  const git = (...args) => run('git', ['-C', dir, ...args], { windowsHide: true });
  await git('config', 'user.name', 'github-actions[bot]');
  await git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  await git('add', '--', 'state/reels');
  const { stdout } = await git('diff', '--cached', '--name-only', '--', 'state/reels');
  if (stdout.trim()) await git('commit', '-q', '-m', 'state: reel container checkpoint');
  for (let i = 0; i < 5; i++) {
    try { await git('push', '-q', 'origin', 'HEAD:main'); return; }
    catch (pushError) {
      try { await git('pull', '-q', '--rebase', 'origin', 'main'); }
      catch (rebaseError) {
        try { await git('rebase', '--abort'); } catch (abortError) { console.error(`Rebase abort failed: ${abortError.message}`); }
        throw rebaseError;
      }
      if (i === 4) throw pushError;
    }
  }
}
