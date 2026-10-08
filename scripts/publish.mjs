// 매일 올리기: 깃허브 예약이 정각 전에 깨우면, 지금 올릴 글(queue/<id>.json)을 골라 인스타에 준비물을 만들어 두고
// 정각까지 기다렸다가 올린 뒤 state/posted/<id>.json에 적는다. 의존 패키지 없이 Node 기본 기능만 쓴다.
// 원본은 비공개 저장소 MattoInsta의 site/scripts/publish.mjs (여기 고치면 다음 달 올릴 때 덮인다).
//
// 쓰임: node scripts/publish.mjs [--dry] [--id <id>]
//   환경: IG_TOKEN(인스타 출입증, 금고) · GITHUB_TOKEN · GITHUB_REPOSITORY(알림 이슈)
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const IG = "https://graph.instagram.com/v25.0";
export const IG_USER = "17841438986051622"; // @matto__lab
const EARLY = 150 * 60e3; // 정각 2시간 반 전부터 준비
const LATE = 90 * 60e3; // 정각보다 90분 넘게 늦으면 올리지 않는다(아침 글이 점심에 올라가지 않게)
const OLD = 7 * 24 * 3600e3;

export const hide = (s, token) => (token ? String(s).split(token).join("***") : String(s));
const kst = (d) => new Date(d.getTime() + 9 * 3600e3);
const when = (id) => {
  const [, m, d, ap] = id.match(/^\d{4}-(\d{2})-(\d{2})-(am|pm)$/);
  return `${Number(m)}/${Number(d)} ${ap === "am" ? "아침" : "저녁"}`;
};

export function pickPost(entries, posted, now) {
  const t = now.getTime();
  return (
    entries
      .filter((e) => !posted.has(e.id))
      .filter((e) => {
        const s = Date.parse(e.slot);
        return t >= s - EARLY && t <= s + LATE;
      })
      .sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot))[0] ?? null
  );
}

export function missed(entries, posted, alerted, now) {
  const t = now.getTime();
  return entries
    .filter((e) => !posted.has(e.id) && !alerted.has(e.id))
    .filter((e) => {
      const s = Date.parse(e.slot);
      return t > s + LATE && t - s < OLD;
    })
    .sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot));
}

// 인스타 API(출입증은 어떤 오류 글에도 남기지 않는다)
export function igApi(token, fetchImpl = fetch) {
  const call = async (method, node, params = {}) => {
    const url = new URL(`${IG}/${node}`);
    let init = { method };
    if (method === "GET") {
      for (const [k, v] of Object.entries({ ...params, access_token: token })) url.searchParams.set(k, v);
    } else init.body = new URLSearchParams({ ...params, access_token: token });
    const res = await fetchImpl(url, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(hide(`인스타 ${method} ${node} ${res.status}: ${body.error?.message ?? "응답을 못 읽었다"}`, token));
    return body;
  };
  return { get: (node, params) => call("GET", node, params), post: (node, params) => call("POST", node, params) };
}

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
export async function alreadyPosted(api, text) {
  const { data = [] } = await api.get(`${IG_USER}/media`, { fields: "id,caption,permalink,timestamp,media_product_type", limit: "12" });
  const want = norm(text);
  const hit = data.find((m) => m.media_product_type !== "REELS" && norm(m.caption) === want);
  return hit ? { mediaId: hit.id, permalink: hit.permalink ?? null } : null;
}

async function prepareOnce(api, entry, sleep) {
  const children = [];
  for (const c of entry.cards) children.push((await api.post(`${IG_USER}/media`, { image_url: c.url, is_carousel_item: "true", alt_text: c.alt })).id);
  const { id } = await api.post(`${IG_USER}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: entry.text, is_ai_generated: "true" });
  for (let i = 0; i < 60; i++) {
    const { status_code: s } = await api.get(id, { fields: "status_code" });
    if (s === "FINISHED") return id;
    if (s === "ERROR" || s === "EXPIRED") throw new Error(`준비물 상태 ${s}`);
    await sleep(5000);
  }
  throw new Error("준비물이 5분이 지나도 끝나지 않았다");
}

export async function prepare(api, entry, sleep) {
  try {
    return await prepareOnce(api, entry, sleep);
  } catch {
    await sleep(30_000); // 카드 주소를 잠깐 못 받는 일이 있다 → 처음부터 한 번 더
    return prepareOnce(api, entry, sleep);
  }
}

// 한 편 올리기. dry면 준비물(FINISHED)까지만 만들고 끝, 기다리지 않는다. wait=false면 정각을 기다리지 않는다(손으로 고른 편)
export async function publishOne({ api, entry, now, sleep, dry = false, wait = true }) {
  const before = await alreadyPosted(api, entry.text);
  if (before) return { status: "already", ...before };
  const creationId = await prepare(api, entry, sleep);
  if (dry) return { status: "dry", creationId };
  const ms = Date.parse(entry.slot) - now().getTime();
  if (wait && ms > 0) await sleep(ms);
  // 준비가 오래 걸려 90분을 넘겼으면 올리지 않는다(아침 글이 점심에 올라가지 않게)
  if (wait && now().getTime() > Date.parse(entry.slot) + LATE) throw new Error("준비하다 정각보다 90분 넘게 늦어져 올리지 않았다");
  const { id } = await api.post(`${IG_USER}/media_publish`, { creation_id: creationId });
  let permalink = null;
  try {
    permalink = (await api.get(id, { fields: "permalink,timestamp" })).permalink ?? null;
  } catch {
    // 올라갔으면 주소는 못 읽어도 된다
  }
  return { status: "posted", mediaId: id, permalink, creationId };
}

const readJson = async (f) => JSON.parse(await readFile(f, "utf8"));
const ids = async (dir) => new Set(existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : []);

const TODAY_SERIES = {
  quiz: { label: "오늘의 한 문제", siteName: "마또의 아침신문", link: "https://news.matto.kr/?from=insta" },
  myth: { label: "그리스 로마 신화 인물 도감", siteName: "매일 읽는 고전", link: "https://classics.matto.kr/?s=greek-myth&from=insta" },
  history: { label: "이야기 한국사", siteName: "이야기 한국사", link: "https://history.matto.kr/?from=insta" },
};

export async function buildToday(dir) {
  const items = [];
  for (const id of [...await ids(path.join(dir, "state", "posted"))].sort().reverse()) {
    const record = await readJson(path.join(dir, "state", "posted", `${id}.json`));
    const file = path.join(dir, "queue", `${id}.json`);
    const queue = existsSync(file) ? await readJson(file) : {};
    const series = queue.series ?? record.series;
    const defaults = Object.hasOwn(TODAY_SERIES, series) ? TODAY_SERIES[series] : null;
    if (!defaults) continue;
    const value = (key, fallback) => typeof queue[key] === "string" && queue[key].trim() ? queue[key] : fallback;
    items.push({
      id, day: id.slice(0, 10), series,
      label: value("label", defaults.label), siteName: value("siteName", defaults.siteName),
      title: value("title", String(queue.text ?? "").split(/\r?\n/)[0]), link: value("link", defaults.link),
      cover: queue.cards?.[0]?.url ?? null, permalink: record.permalink ?? null,
    });
    if (items.length === 60) break;
  }
  return { items };
}

export async function writeToday(dir) {
  const content = JSON.stringify(await buildToday(dir), null, 2) + "\n";
  const file = path.join(dir, "state", "today.json");
  if (existsSync(file) && await readFile(file, "utf8") === content) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
async function mark(dir, sub, name, v) {
  await mkdir(path.join(dir, "state", sub), { recursive: true });
  await writeFile(path.join(dir, "state", sub, `${name}.json`), JSON.stringify(v, null, 2) + "\n");
}

// 저장소 폴더 하나에서 한 번 일한다. 알림은 편마다 한 번만(state/missed · state/failed에 적어 둔다)
export async function runOnce({ dir, api, github, now, sleep, id = null, dry = false, token = "" }) {
  const qDir = path.join(dir, "queue");
  const entries = [];
  if (existsSync(qDir)) for (const f of (await readdir(qDir)).filter((f) => f.endsWith(".json"))) entries.push(await readJson(path.join(qDir, f)));
  const posted = await ids(path.join(dir, "state", "posted"));
  const failed = await ids(path.join(dir, "state", "failed"));
  const missedSeen = await ids(path.join(dir, "state", "missed"));
  const out = { posted: null, failed: null, dry: null, already: null, alerts: 0 };
  const alert = async (title, body) => {
    await github.issue(title, hide(body, token));
    out.alerts++;
  };

  if (!id) {
    for (const e of missed(entries, posted, new Set([...missedSeen, ...failed]), now())) {
      await alert(`[인스타] ${when(e.id)} 글을 못 올렸다`, `- 올릴 시각: ${e.slot}\n- 그 시각 앞뒤로 올리기 작업이 돌지 못했다(깃허브 예약이 밀렸거나 빠졌다). 이 편은 건너뛰고 다음 편부터 그대로 올라간다.\n- 지금이라도 올리려면: 저장소 Actions → publish → Run workflow, id에 \`${e.id}\``);
      await mark(dir, "missed", e.id, { id: e.id, at: now().toISOString() });
    }
    const k = kst(now());
    const month = k.toISOString().slice(0, 7);
    const weekday = k.getUTCDay() >= 1 && k.getUTCDay() <= 5;
    if (weekday && !existsSync(path.join(qDir, "months", `${month}.json`)) && !missedSeen.has(`month-${month}`)) {
      await alert(`[인스타] ${Number(month.slice(5))}월 올릴 글이 없다`, `- 공개 저장소에 ${month} 목록(queue/months/${month}.json)이 없다. 지난달 1~5일 글 준비가 끝나지 않았거나 공개 저장소에 올리지 못했다.\n- 비공개 저장소 notices/ 와 이 PC의 F:\\VibeCoding\\_auto\\logs\\monthly-runs.log 를 본다.`);
      await mark(dir, "missed", `month-${month}`, { month, at: now().toISOString() });
    }
  }

  const entry = id ? (entries.find((e) => e.id === id && !posted.has(e.id)) ?? null) : pickPost(entries, posted, now());
  if (!entry) return out;
  try {
    if (!api) throw new Error("인스타 출입증(IG_TOKEN)이 저장소 금고에 없다");
    const r = await publishOne({ api, entry, now, sleep, dry, wait: !id });
    if (r.status === "dry") out.dry = entry.id;
    else {
      out[r.status === "already" ? "already" : "posted"] = entry.id;
      await mark(dir, "posted", entry.id, { id: entry.id, slot: entry.slot, mediaId: r.mediaId, permalink: r.permalink, postedAt: now().toISOString(), how: r.status });
    }
  } catch (err) {
    out.failed = entry.id;
    if (dry) console.error(`미리 해 보기 실패: ${hide(err?.message ?? String(err), token)}`);
    else if (!failed.has(entry.id)) {
      await alert(`[인스타] ${when(entry.id)} 글 올리기 실패`, `- 올릴 시각: ${entry.slot}\n- 까닭: ${err?.message ?? String(err)}\n- 출입증 문제면 이 PC의 새벽 작업이 연장하고 금고에 다시 넣는다. 다음 예약이 다시 해 본다(90분 안이면).`);
      await mark(dir, "failed", entry.id, { id: entry.id, at: now().toISOString(), error: hide(err?.message ?? String(err), token) });
    }
  }
  return out;
}

function githubIssues(repo, token) {
  return {
    async issue(title, body) {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      // 못 열었으면 던진다: 「알렸다」는 기록을 남기지 않고 작업이 실패로 끝나 깃허브 실패 메일이 대신 간다
      if (!res.ok) throw new Error(`알림 이슈를 못 열었다: ${res.status}`);
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const id = args.includes("--id") ? args[args.indexOf("--id") + 1] || null : null;
  const dry = args.includes("--dry");
  const token = process.env.IG_TOKEN ?? "";
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let r;
  try {
    r = await runOnce({
      dir, id, dry, token,
      api: token ? igApi(token) : null, // 출입증이 없어도 알림(못 올린 글 · 이번 달 글 없음)은 한다

      github: githubIssues(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN),
      now: () => new Date(),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    });
  } finally {
    try {
      await writeToday(dir);
    } catch (err) {
      console.error(`오늘 목록 만들기 실패: ${hide(err?.message ?? String(err), token).replace(/[\r\n]+/g, " ")}`);
    }
  }
  console.log(JSON.stringify(r));
  return r.failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(hide(err?.message ?? String(err), process.env.IG_TOKEN ?? ""));
      process.exit(1);
    },
  );
}
