// Tracks changes in Jira issues and linked Confluence pages between runs.
//
// The sources of truth are the systems themselves, not our export:
//   - Jira: the issue changelog (every field change with author and date, ids increase) + comments
//     (created/updated; Jira does not keep the old text of an edited comment — it comes from the snapshot);
//   - Confluence: page version number, the version list (who/when/version message) and a diff between two
//     versions fetched from Confluence itself (status=historical) — so changes to our Markdown converter
//     do not produce false differences; comments (version, resolution) and attachments (version).
// Snapshot of the previous run — .jira/out/track/state.json, reports — .jira/out/track/reports/.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError, RestClient, isFatal, searchIssues } from './client.ts';
import { fetchAll, resolvePageId } from './confluence.ts';
import { htmlToMarkdown, textDiff, wordChanges } from './convert.ts';

type Json = any;

interface CommentSnap {
  updated: string;
  author: string;
  body: string;
}

interface IssueSnap {
  summary: string;
  status: string;
  updated: string;
  lastHistoryId: number;
  comments: Record<string, CommentSnap>;
  pages: string[];
  checkedAt: string;
}

interface WikiCommentSnap {
  version: number;
  when: string;
  author: string;
  status?: string;
  body: string;
}

interface WikiAttachmentSnap {
  title: string;
  version: number;
  when: string;
  by: string;
}

interface PageSnap {
  title: string;
  version: number;
  when: string;
  /** Text of `version` (stable Markdown) — fallback in case this version is deleted from Confluence history */
  text?: string;
  comments: Record<string, WikiCommentSnap>;
  attachments: Record<string, WikiAttachmentSnap>;
  checkedAt: string;
}

interface TrackState {
  lastRun?: string;
  issues: Record<string, IssueSnap>;
  pages: Record<string, PageSnap>;
}

export interface TrackOptions {
  keys: string[];
  jql?: string;
  pages: string[];
  since?: string;
  remove: string[];
}

/** How we compare: with the previous run's snapshot, with the --since date, or only record a baseline. */
type Mode = { kind: 'state' } | { kind: 'since'; time: number } | { kind: 'baseline' };

/** Result of checking one item: report lines if something changed. */
interface ItemResult {
  title: string;
  lines: string[];
  baseline?: string;
}

// Jira returns the zone as +0300, Confluence as +03:00; Date.parse reliably understands only the latter.
// A number is epoch ms (Confluence resolution.lastModifiedDate; 0 = "never").
function toTime(iso: string | number | undefined): number {
  if (typeof iso === 'number') return iso > 0 ? iso : NaN;
  if (!iso) return NaN;
  return Date.parse(iso.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
}

function fmt(iso: string | number | undefined): string {
  const t = toTime(iso);
  if (Number.isNaN(t)) return iso ? String(iso) : '—';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function diffBlock(before: string, after: string): string[] {
  const d = textDiff(before, after);
  if (!d) return ['_(text unchanged — only formatting/metadata changed)_'];
  const words = before ? wordChanges(before, after) : [];
  return [
    '```diff',
    d,
    '```',
    ...(words.length ? ['', 'What exactly changed (`[-before-]{+after+}`):', '', ...words.map((w) => `- \`${w.replace(/`/g, "'")}\``)] : []),
  ];
}

function quote(text: string): string[] {
  return text.trim().split('\n').map((l) => `> ${l}`);
}

// ---------- Jira ----------

const WIKI_URL_RE = /https?:\/\/[^\s|\]\)"<>]+/g;

async function linkedPages(jira: RestClient, wiki: RestClient | undefined, key: string, texts: string[]): Promise<{ ids: string[]; errors: string[] }> {
  if (!wiki) return { ids: [], errors: [] };
  const urls = new Set<string>();
  const remote: Json[] = await jira.get(`/rest/api/2/issue/${encodeURIComponent(key)}/remotelink`);
  for (const r of remote) if (r.object?.url) urls.add(r.object.url);
  for (const t of texts) for (const m of t.matchAll(WIKI_URL_RE)) urls.add(m[0]);
  const host = new URL(wiki.baseUrl).host;
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.host !== host) continue;
    // Pages only: attachments (/download/…) and spaces without a page are skipped
    if (!/pageId=|\/pages\/\d+|\/display\/[^/]+\/./.test(url)) continue;
    try {
      ids.add(await resolvePageId(wiki, url));
    } catch (e) {
      if (isFatal(e)) throw e;
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  return { ids: [...ids], errors };
}

function renderHistoryItem(it: Json): string[] {
  const from = String(it.fromString ?? it.from ?? '');
  const to = String(it.toString ?? it.to ?? '');
  if (from.length > 120 || to.length > 120 || /\n/.test(from + to)) {
    return [`  - **${it.field}**:`, ...diffBlock(from, to).map((l) => `    ${l}`)];
  }
  return [`  - **${it.field}**: ${from || '∅'} → ${to || '∅'}`];
}

async function trackIssue(
  jira: RestClient,
  wiki: RestClient | undefined,
  key: string,
  prev: IssueSnap | undefined,
  mode: Mode,
): Promise<{ snap: IssueSnap; result: ItemResult }> {
  const issue: Json = await jira.get(
    `/rest/api/2/issue/${encodeURIComponent(key)}?expand=changelog&fields=summary,status,updated,description`,
  );
  const commentsRes: Json = await jira.get(`/rest/api/2/issue/${encodeURIComponent(key)}/comment?maxResults=1000`);
  const comments: Json[] = commentsRes.comments ?? [];
  // Server/DC returns history oldest first, Cloud newest first; the report is always chronological
  const histories: Json[] = [...(issue.changelog?.histories ?? [])].sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
  const f = issue.fields;
  const { ids: pages, errors: pageErrors } = await linkedPages(jira, wiki, key, [
    f.description ?? '',
    ...comments.map((c) => c.body ?? ''),
  ]);

  const snap: IssueSnap = {
    summary: f.summary,
    status: f.status?.name,
    updated: f.updated,
    lastHistoryId: Math.max(0, ...histories.map((h) => Number(h.id))),
    comments: Object.fromEntries(
      comments.map((c) => [c.id, { updated: c.updated, author: c.author?.displayName, body: c.body ?? '' }]),
    ),
    pages,
    checkedAt: new Date().toISOString(),
  };

  const title = `${key} — ${f.summary} [${f.status?.name}]`;
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);

  if (mode.kind === 'baseline' || (mode.kind === 'state' && !prev)) {
    return {
      snap,
      result: {
        title,
        lines,
        baseline: `updated ${fmt(f.updated)}, ${histories.length} history entries, ${comments.length} comments, wiki pages: ${pages.length}`,
      },
    };
  }

  if (issue.changelog && issue.changelog.total > histories.length) {
    add(`⚠️ Jira returned ${histories.length} of ${issue.changelog.total} history entries — some changes may be missing.`, '');
  }

  // Field history
  const newHistories = histories.filter((h) =>
    mode.kind === 'state' ? Number(h.id) > prev!.lastHistoryId : toTime(h.created) >= mode.time,
  );
  if (newHistories.length) {
    add('### Field changes', '');
    for (const h of newHistories) {
      add(`- **${fmt(h.created)}** ${h.author?.displayName ?? '—'}:`);
      for (const it of h.items) add(...renderHistoryItem(it));
    }
    add('');
  }

  // Comments
  const commentLines: string[] = [];
  for (const c of comments) {
    const old = prev?.comments[c.id];
    const author = c.author?.displayName;
    const isNew = mode.kind === 'state' ? !old : toTime(c.created) >= mode.time;
    const isEdited = !isNew && (mode.kind === 'state' ? old!.updated !== c.updated : toTime(c.updated) >= mode.time);
    if (isNew) {
      commentLines.push(`- 💬 **New** — ${author}, ${fmt(c.created)}`, '', ...quote(c.body ?? ''), '');
    } else if (isEdited) {
      commentLines.push(`- ✏️ **Edited** comment by ${author} from ${fmt(c.created)} — ${c.updateAuthor?.displayName}, ${fmt(c.updated)}`, '');
      if (old && old.body !== c.body) commentLines.push(...diffBlock(old.body, c.body ?? ''), '');
      else commentLines.push('_(no previous text in the snapshot — current text:)_', '', ...quote(c.body ?? ''), '');
    }
  }
  if (prev) {
    for (const [id, old] of Object.entries(prev.comments)) {
      if (!comments.some((c) => c.id === id)) commentLines.push(`- 🗑️ **Deleted** comment by ${old.author} (last state from ${fmt(old.updated)})`, '', ...quote(old.body), '');
    }
  }
  if (commentLines.length) add('### Comments', '', ...commentLines);

  // New/removed wiki links
  if (prev) {
    const added = pages.filter((p) => !prev.pages.includes(p));
    const removed = prev.pages.filter((p) => !pages.includes(p));
    if (added.length || removed.length) {
      add('### Linked wiki pages', '');
      for (const p of added) add(`- ➕ pageId ${p}`);
      for (const p of removed) add(`- ➖ pageId ${p}`);
      add('');
    }
  }
  if (pageErrors.length) add('### ⚠️ Could not resolve wiki pages', '', ...pageErrors.map((e) => `- ${e}`), '');

  return { snap, result: { title, lines } };
}

// ---------- Confluence ----------

async function pageMarkdown(wiki: RestClient, id: string, version?: number): Promise<string> {
  const query = version ? `status=historical&version=${version}&expand=body.view` : 'expand=body.view';
  const page: Json = await wiki.get(`/rest/api/content/${id}?${query}`);
  return htmlToMarkdown(page.body?.view?.value ?? '', wiki.baseUrl, { stable: true });
}

/**
 * Text of the version we compare with. Priority: the version itself from Confluence → our snapshot of it
 * (if it was deleted from history) → the nearest older version still in history.
 */
async function previousText(
  wiki: RestClient,
  id: string,
  version: number,
  prev: PageSnap | undefined,
  versions: Json[] | undefined,
  add: (...l: string[]) => void,
): Promise<string> {
  try {
    return await pageMarkdown(wiki, id, version);
  } catch (e) {
    if (isFatal(e) || !(e instanceof HttpError) || e.status !== 404) throw e;
  }
  if (prev?.version === version && prev.text !== undefined) {
    add(`_v${version} was deleted from Confluence history — comparing with the saved snapshot of v${version}._`, '');
    return prev.text;
  }
  const fallback = versions?.filter((v) => v.number < version).reduce((m, v) => Math.max(m, v.number), 0) ?? 0;
  add(
    fallback
      ? `_v${version} was deleted from Confluence history and there is no snapshot — comparing with v${fallback}._`
      : `_v${version} was deleted from Confluence history, with no snapshot or older versions — showing the whole current text._`,
    '',
  );
  return fallback ? pageMarkdown(wiki, id, fallback) : '';
}

async function listVersions(wiki: RestClient, id: string): Promise<Json[] | undefined> {
  try {
    return await fetchAll(wiki, `/rest/experimental/content/${id}/version`);
  } catch (e) {
    if (isFatal(e)) throw e;
    return undefined;
  }
}

async function trackPage(
  wiki: RestClient,
  id: string,
  prev: PageSnap | undefined,
  mode: Mode,
  refs: string[],
): Promise<{ snap: PageSnap | undefined; result: ItemResult }> {
  let page: Json;
  try {
    page = await wiki.get(`/rest/api/content/${id}?expand=version,body.view`);
  } catch (e) {
    if (isFatal(e) || !(e instanceof HttpError)) throw e;
    const title = `wiki ${id}${prev ? ` — ${prev.title}` : ''}`;
    return { snap: prev, result: { title, lines: [`❌ Page unavailable (HTTP ${e.status}): deleted, moved, or no permission.`, ''] } };
  }
  const comments = await fetchAll(
    wiki,
    `/rest/api/content/${id}/child/comment?depth=all&expand=body.view,version,history,ancestors,extensions.inlineProperties,extensions.resolution`,
  );
  const attachments = await fetchAll(wiki, `/rest/api/content/${id}/child/attachment?expand=version`);

  const currentText = htmlToMarkdown(page.body?.view?.value ?? '', wiki.baseUrl, { stable: true });
  const snap: PageSnap = {
    title: page.title,
    version: page.version.number,
    when: page.version.when,
    text: currentText,
    comments: Object.fromEntries(
      comments.map((c) => [
        c.id,
        {
          version: c.version?.number ?? 1,
          when: c.version?.when ?? c.history?.createdDate,
          author: c.history?.createdBy?.displayName,
          status: c.extensions?.resolution?.status,
          body: htmlToMarkdown(c.body?.view?.value ?? '', wiki.baseUrl),
        },
      ]),
    ),
    attachments: Object.fromEntries(
      attachments.map((a) => [a.id, { title: a.title, version: a.version?.number, when: a.version?.when, by: a.version?.by?.displayName }]),
    ),
    checkedAt: new Date().toISOString(),
  };

  const refsText = refs.length ? ` (from ${refs.join(', ')})` : '';
  const title = `wiki: ${page.title} — v${page.version.number}${refsText}`;
  const lines: string[] = [];
  const add = (...l: string[]) => lines.push(...l);
  add(`${wiki.baseUrl}/pages/viewpage.action?pageId=${id}`, '');

  if (mode.kind === 'baseline' || (mode.kind === 'state' && !prev)) {
    return {
      snap,
      result: {
        title,
        lines: [],
        baseline: `v${page.version.number} from ${fmt(page.version.when)}, ${comments.length} comments, ${attachments.length} attachments`,
      },
    };
  }
  const startLength = lines.length;

  // Page versions
  let baseVersion: number | undefined;
  const versions = await listVersions(wiki, id);
  if (mode.kind === 'state') {
    if (page.version.number > prev!.version) baseVersion = prev!.version;
  } else if (toTime(page.version.when) >= mode.time) {
    // The last version before --since; if the page was created later, compare with an empty one
    baseVersion = versions?.filter((v) => toTime(v.when) < mode.time).reduce((m, v) => Math.max(m, v.number), 0) ?? 0;
  }
  if (baseVersion !== undefined) {
    add(`### Page text: ${baseVersion ? `v${baseVersion}` : 'new page'} → v${page.version.number}`, '');
    if (prev && prev.title !== page.title) add(`- Title: "${prev.title}" → "${page.title}"`);
    if (versions) {
      const newer = versions.filter((v) => v.number > baseVersion!).sort((a, b) => a.number - b.number);
      for (const v of newer) add(`- v${v.number} — ${v.by?.displayName ?? '—'}, ${fmt(v.when)}${v.message ? ` · "${v.message}"` : ''}`);
      // Confluence may delete/merge versions (manual deletion, merged collaborative-editing drafts)
      const present = new Set(newer.map((v) => v.number));
      const missing: number[] = [];
      for (let n = baseVersion + 1; n < page.version.number; n++) if (!present.has(n)) missing.push(n);
      if (missing.length) add(`- _v${missing.join(', v')} missing from Confluence history (deleted or merged)_`);
    } else {
      add(`- (intermediate version list unavailable) latest: ${page.version.by?.displayName}, ${fmt(page.version.when)}`);
    }
    add('');
    const before = baseVersion ? await previousText(wiki, id, baseVersion, prev, versions, add) : '';
    add(...diffBlock(before, currentText), '');
  }

  // Comments
  const byId = new Map(comments.map((c) => [c.id, c]));
  const threadOf = (c: Json): string => {
    const root = [...(c.ancestors ?? [])].find((a: Json) => byId.has(a.id));
    const sel = (root ? byId.get(root.id) : c)?.extensions?.inlineProperties?.originalSelection;
    return sel ? ` on text "${sel}"` : '';
  };
  const commentLines: string[] = [];
  for (const c of comments) {
    const old = prev?.comments[c.id];
    const cur = snap.comments[c.id];
    const created = c.history?.createdDate;
    const isNew = mode.kind === 'state' ? !old : toTime(created) >= mode.time;
    const isEdited = !isNew && (mode.kind === 'state' ? old!.version !== cur.version : cur.version > 1 && toTime(cur.when) >= mode.time);
    const kind = `${c.extensions?.location === 'inline' ? 'inline' : 'comment'}${c.ancestors?.some((a: Json) => byId.has(a.id)) ? ', reply' : ''}`;
    if (isNew) {
      commentLines.push(`- 💬 **New** (${kind}${threadOf(c)}) — ${cur.author}, ${fmt(created)}`, '', ...quote(cur.body), '');
    } else if (isEdited) {
      commentLines.push(`- ✏️ **Edited** (${kind}${threadOf(c)}) by ${cur.author} from ${fmt(created)} — ${fmt(cur.when)}`, '');
      if (old && old.body !== cur.body) commentLines.push(...diffBlock(old.body, cur.body), '');
      else commentLines.push('_(no previous text in the snapshot — current text:)_', '', ...quote(cur.body), '');
    }
    const res = c.extensions?.resolution;
    const statusChanged = mode.kind === 'state' ? old && old.status !== cur.status : res?.lastModifiedDate && toTime(res.lastModifiedDate) >= mode.time;
    if (!isNew && statusChanged) {
      commentLines.push(
        `- ${cur.status === 'resolved' ? '✔️' : '↩️'} **Status** of comment by ${cur.author}${threadOf(c)}: ` +
          `${old && old.status !== cur.status ? `${old.status} → ` : ''}${cur.status}` +
          // lastModifiedDate = 0 and an anonymous author — nobody changed the status (the comment was just created open)
          `${res?.lastModifiedDate > 0 ? ` — ${res.lastModifier?.displayName}, ${fmt(res.lastModifiedDate)}` : ''}`,
        '',
      );
    }
  }
  if (prev) {
    for (const [cid, old] of Object.entries(prev.comments)) {
      if (!byId.has(cid)) commentLines.push(`- 🗑️ **Deleted** comment by ${old.author} (last state from ${fmt(old.when)})`, '', ...quote(old.body), '');
    }
  }
  if (commentLines.length) add('### Comments', '', ...commentLines);

  // Attachments
  const attLines: string[] = [];
  for (const a of attachments) {
    const old = prev?.attachments[a.id];
    const cur = snap.attachments[a.id];
    const isNew = mode.kind === 'state' ? !old : cur.version === 1 && toTime(cur.when) >= mode.time;
    const isUpdated = !isNew && (mode.kind === 'state' ? old!.version !== cur.version : toTime(cur.when) >= mode.time);
    if (isNew) attLines.push(`- 📎 **New** ${cur.title} — ${cur.by}, ${fmt(cur.when)}`);
    else if (isUpdated) attLines.push(`- 🔁 **New version** ${cur.title}: v${old?.version ?? '?'} → v${cur.version} — ${cur.by}, ${fmt(cur.when)}`);
  }
  if (prev) {
    for (const [aid, old] of Object.entries(prev.attachments)) {
      if (!attachments.some((a) => a.id === aid)) attLines.push(`- 🗑️ **Deleted** ${old.title} (v${old.version})`);
    }
  }
  if (attLines.length) add('### Attachments', '', ...attLines, '');

  return { snap, result: { title, lines: lines.length > startLength ? lines : [] } };
}

// ---------- run ----------

async function loadState(file: string): Promise<TrackState> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as TrackState;
  } catch {
    return { issues: {}, pages: {} };
  }
}

export async function track(jira: RestClient, wiki: RestClient | undefined, opts: TrackOptions, outDir: string) {
  const dir = join(outDir, 'track');
  const stateFile = join(dir, 'state.json');
  const state = await loadState(stateFile);
  const now = new Date();

  for (const r of opts.remove) {
    const k = r.toUpperCase();
    if (state.issues[k]) delete state.issues[k];
    else if (state.pages[r]) delete state.pages[r];
    else console.log(`⚠️ ${r} is not tracked`);
  }

  let keys = opts.keys.map((k) => k.toUpperCase());
  if (opts.jql) {
    const found = await searchIssues(jira, opts.jql, 'summary', 500);
    // Cloud returns no total and may cut the page to 100 — warn if it looks truncated
    if (found.total !== undefined ? found.total > found.issues.length : found.issues.length >= 100) {
      console.log(`⚠️ JQL found ${found.total ?? `${found.issues.length}+`}, checking the first ${found.issues.length}`);
    }
    keys.push(...found.issues.map((i: Json) => i.key));
  }
  const explicitPages: string[] = [];
  if (opts.pages.length) {
    if (!wiki) throw new Error('--page needs CONFLUENCE_BASE_URL / CONFLUENCE_TOKEN in .jira/.env');
    for (const p of opts.pages) explicitPages.push(await resolvePageId(wiki, p));
  }
  const checkAll = !keys.length && !opts.jql && !explicitPages.length;
  if (checkAll) keys = Object.keys(state.issues);
  keys = [...new Set(keys)];

  if (!keys.length && !explicitPages.length && (!checkAll || !Object.keys(state.pages).length)) {
    if (opts.remove.length) {
      await mkdir(dir, { recursive: true });
      await writeFile(stateFile, JSON.stringify(state, null, 2));
      console.log('Removed from tracking.');
      return;
    }
    throw new Error('Nothing to track: pass issue keys, --jql "<JQL>" or --page <pageId|URL>.');
  }

  const sinceTime = opts.since ? toTime(opts.since.length === 10 ? `${opts.since}T00:00:00` : opts.since) : NaN;
  if (opts.since && Number.isNaN(sinceTime)) throw new Error(`Could not parse the --since date "${opts.since}" (format YYYY-MM-DD)`);
  const modeFor = (hasPrev: boolean): Mode =>
    !Number.isNaN(sinceTime) ? { kind: 'since', time: sinceTime } : hasPrev ? { kind: 'state' } : { kind: 'baseline' };

  const changed: ItemResult[] = [];
  const baselines: ItemResult[] = [];
  const unchanged: string[] = [];
  const failed: string[] = [];
  const collect = (r: ItemResult) => {
    if (r.baseline) baselines.push(r);
    else if (r.lines.length) changed.push(r);
    else unchanged.push(r.title);
  };

  const pageRefs = new Map<string, string[]>();
  for (const key of keys) {
    process.stderr.write(`… ${key}\n`);
    try {
      const { snap, result } = await trackIssue(jira, wiki, key, state.issues[key], modeFor(!!state.issues[key]));
      state.issues[key] = snap;
      for (const p of snap.pages) pageRefs.set(p, [...(pageRefs.get(p) ?? []), key]);
      collect(result);
    } catch (e) {
      if (isFatal(e)) throw e;
      failed.push(`${key}: ${(e as Error).message}`);
    }
  }

  const pageIds = new Set([...pageRefs.keys(), ...explicitPages, ...(checkAll ? Object.keys(state.pages) : [])]);
  if (pageIds.size && !wiki) failed.push(`Wiki pages (${pageIds.size}) skipped: Confluence is not configured in .jira/.env`);
  if (wiki) {
    for (const id of pageIds) {
      process.stderr.write(`… wiki ${id}\n`);
      try {
        const { snap, result } = await trackPage(wiki, id, state.pages[id], modeFor(!!state.pages[id]), pageRefs.get(id) ?? []);
        if (snap) state.pages[id] = snap;
        collect(result);
      } catch (e) {
        if (isFatal(e)) throw e;
        failed.push(`wiki ${id}: ${(e as Error).message}`);
      }
    }
  }

  const report: string[] = [];
  const add = (...l: string[]) => report.push(...l);
  add('# Jira / Confluence changes', '');
  add(`- **Checked:** ${fmt(now.toISOString())}`);
  add(opts.since ? `- **Changes since:** ${opts.since}` : `- **Previous check:** ${state.lastRun ? fmt(state.lastRun) : '— (first run)'}`);
  add(`- **Changed:** ${changed.length}, unchanged: ${unchanged.length}, newly tracked: ${baselines.length}${failed.length ? `, errors: ${failed.length}` : ''}`, '');
  if (changed.length) add('Changed:', ...changed.map((r) => `- ${r.title}`), '');
  if (baselines.length) {
    add('Now tracked (baseline; changes will show from the next run or with `--since`):');
    add(...baselines.map((r) => `- ${r.title}: ${r.baseline}`), '');
  }
  if (unchanged.length) add('Unchanged:', ...unchanged.map((t) => `- ${t}`), '');
  if (failed.length) add('Errors:', ...failed.map((f) => `- ❌ ${f}`), '');
  for (const r of changed) add('---', '', `## ${r.title}`, '', ...r.lines);

  state.lastRun = now.toISOString();
  await mkdir(join(dir, 'reports'), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2));
  const stamp = fmt(now.toISOString()).replace(' ', '_').replace(':', '-');
  const reportFile = join(dir, 'reports', `${stamp}.md`);
  await writeFile(reportFile, report.join('\n'));
  console.log(report.join('\n'));
  console.log(`\nReport: ${reportFile}`);
}
