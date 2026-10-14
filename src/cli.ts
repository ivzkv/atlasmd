// Read-only CLI for Jira and Confluence. Output is Markdown on stdout (easy to read for both humans and Claude).
// Usage:  atlasmd <command> [args]   (settings and results live in the project's .jira/, see paths.ts)
//   version               tool version (from its package.json); --version / -v too, but through npx only after --,
//                         because npx intercepts them and prints npm's own version
//   init                  set up the current folder: .jira/.env from the template + .jira/.gitignore (folder stays out of git)
//                         + the Claude Code skill (same as `skill`)
//   skill                 install / update .claude/skills/atlasmd/SKILL.md from this package version
//   probe                 what the tokens can do: version, user, permissions, projects, boards, fields, attachments, Confluence
//   docx <file.docx>…     local .docx → .md next to it
//
//   jira issue <KEY> [--attachments]
//                         full issue → stdout and .jira/out/<KEY>/<KEY>.md; images are downloaded and shown in the .md,
//                         with --attachments the other attachments too (.docx → also .md)
//   jira search "<JQL>" [N]
//                         issue search, N results (default 20)
//   jira attachments <KEY>
//                         download all issue attachments to .jira/out/<KEY>/ (.docx also to .md)
//
//   wiki page <pageId|URL> [--attachments]
//                         Confluence page as Markdown + comments (inline too) + attachments
//   wiki search "<text|CQL>" [N] [--space SPACE]
//                         wiki page search: text → text ~ "…", or ready CQL; N (default 20)
//
//   track [KEY…] [--jql "<JQL>"] [--page <pageId|URL>]… [--since YYYY-MM-DD] [--remove KEY|pageId]…
//                         changes in issues and linked wiki pages since the previous run (or a date);
//                         without arguments — everything already tracked

import { ENV_FILE, OUT_DIR, envHint } from './paths.ts';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, RestClient, countIssues, isFatal, loadConfluenceConfig, loadJiraConfig, searchIssues, userId } from './client.ts';
import { docxToMarkdownFile, htmlToMarkdown, markdownFileLink, safeFileName, setFileTime } from './convert.ts';
import { probeConfluence, wikiPage, wikiSearch } from './confluence.ts';
import { track, type TrackOptions } from './track.ts';

type Json = any;

// The package's package.json is one level up from both src/ (development) and dist/ (installed package)
const VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const out = (line = '') => console.log(line);

async function saveRaw(name: string, data: unknown) {
  const file = join(OUT_DIR, 'raw', `${name}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2));
}

async function section(title: string, body: () => Promise<void>) {
  out(`\n## ${title}\n`);
  try {
    await body();
  } catch (e) {
    if (isFatal(e)) throw e;
    out(`❌ ${(e as Error).message}`);
  }
}

// ---------- probe ----------

async function probe(jira: RestClient) {
  out(`# Jira probe — ${jira.baseUrl} (atlasmd v${VERSION})`);
  out(`Auth: ${jira.authLabel}; platform: ${jira.cloud ? 'Cloud' : 'Server/DC'}`);
  out(`Settings: ${ENV_FILE}; results: ${OUT_DIR}`);
  out(`Skill: ${SKILL_STATUS_TEXT[skillStatus()]}`);

  await section('Server', async () => {
    const info: Json = await jira.get('/rest/api/2/serverInfo');
    await saveRaw('serverInfo', info);
    out(`- Version: ${info.version} (${info.deploymentType ?? 'Server'}), build ${info.buildNumber}`);
    out(`- Title: ${info.serverTitle}`);
  });

  let me: Json;
  await section('Token user', async () => {
    me = await jira.get('/rest/api/2/myself?expand=groups,applicationRoles');
    await saveRaw('myself', me);
    out(`- ${me.displayName} (\`${userId(me)}\`), ${me.emailAddress ?? 'no email'}, active: ${me.active}`);
    out(`- Groups: ${me.groups?.items?.map((g: Json) => g.name).join(', ') || '—'}`);
    out(`- Application roles: ${me.applicationRoles?.items?.map((r: Json) => r.name).join(', ') || '—'}`);
  });

  const projects: Json[] = [];
  await section('Visible projects', async () => {
    projects.push(...(await jira.get<Json[]>('/rest/api/2/project')));
    await saveRaw('projects', projects);
    out(`Total: **${projects.length}**\n`);
    for (const p of projects.slice(0, 60)) out(`- \`${p.key}\` — ${p.name}`);
    if (projects.length > 60) out(`- … ${projects.length - 60} more (full list in ${join(OUT_DIR, 'raw', 'projects.json')})`);
  });

  await section('Global permissions', async () => {
    const perms = await myPermissions(jira, '');
    await saveRaw('permissions-global', perms);
    printPermissions(perms);
  });

  // Permissions in the main project (JIRA_PROJECT) if it is set and visible, otherwise in the first visible one
  const mainKey = process.env.JIRA_PROJECT?.trim();
  const target = (mainKey && projects.find((p) => p.key === mainKey)) || projects[0];
  if (target) {
    await section(`Permissions in project ${target.key}`, async () => {
      const perms = await myPermissions(jira, `projectKey=${encodeURIComponent(target.key)}`);
      await saveRaw(`permissions-${target.key}`, perms);
      printPermissions(perms);
    });
  }

  await section('Search (JQL)', async () => {
    const total = (jql: string) => countIssues(jira, jql);
    out(`- All visible issues: **${await total('order by updated DESC')}**`);
    if (target) out(`- In ${target.key}: **${await total(`project = "${target.key}"`)}**`);
    out(`- My open (assignee = currentUser()): **${await total('assignee = currentUser() AND resolution = Unresolved')}**`);
    const recent = await searchIssues(jira, 'order by updated DESC', 'summary,status,updated', 5);
    out('\nRecently updated:');
    for (const i of recent.issues) out(`- \`${i.key}\` [${i.fields.status?.name}] ${i.fields.summary}`);
  });

  await section('Agile boards', async () => {
    const boards: Json = await jira.get('/rest/agile/1.0/board?maxResults=50');
    await saveRaw('boards', boards);
    out(`Visible boards: **${boards.total ?? boards.values.length}**`);
    for (const b of boards.values.slice(0, 20)) out(`- #${b.id} ${b.name} (${b.type})`);
  });

  await section('Fields', async () => {
    const fields: Json[] = await jira.get('/rest/api/2/field');
    await saveRaw('fields', fields);
    const custom = fields.filter((f) => f.custom);
    out(`Total fields: ${fields.length}, custom: ${custom.length} (full list in ${join(OUT_DIR, 'raw', 'fields.json')})`);
    // Cyrillic alternatives match field names on Jira instances localized in Ukrainian/Russian
    const interesting = custom.filter((f) => /epic|sprint|story|team|component|компонент|епік|спринт/i.test(f.name));
    for (const f of interesting) out(`- \`${f.id}\` ${f.name}`);
  });

  await section('Attachments', async () => {
    const found = await searchIssues(jira, 'attachments is not EMPTY order by updated DESC', 'attachment', 1);
    const issue = found.issues?.[0];
    const att = issue?.fields.attachment?.[0];
    if (!att) return out('No issue with attachments found.');
    const res = await jira.raw(att.content, { accept: '*/*' });
    await res.body?.cancel();
    out(`- Test download of \`${att.filename}\` from \`${issue.key}\`: HTTP ${res.status}, ${res.headers.get('content-type')}`);
    out(res.ok ? '- ✅ Attachments can be downloaded' : '- ❌ Attachments are unavailable');
  });

  const confluence = loadConfluenceConfig();
  await section('Confluence', async () => {
    if (!confluence) return out(`Not configured (CONFLUENCE_BASE_URL / CONFLUENCE_TOKEN: ${envHint()}).`);
    out(`${confluence.baseUrl}\n`);
    await probeConfluence(new RestClient(confluence), saveRaw);
  });

  out(`\nRaw responses saved to ${join(OUT_DIR, 'raw')}`);
}

async function myPermissions(jira: RestClient, query: string): Promise<Record<string, Json>> {
  try {
    return (await jira.get<Json>(`/rest/api/2/mypermissions?${query}`)).permissions;
  } catch (e) {
    // Newer DC versions require an explicit permissions list — take all keys from /permissions
    if (!(e instanceof HttpError) || e.status !== 400) throw e;
    const all: Json = await jira.get('/rest/api/2/permissions');
    const keys = Object.keys(all.permissions).join(',');
    return (await jira.get<Json>(`/rest/api/2/mypermissions?${query}${query ? '&' : ''}permissions=${keys}`)).permissions;
  }
}

function printPermissions(perms: Record<string, Json>) {
  const have = Object.values(perms).filter((p) => p.havePermission).map((p) => p.key).sort();
  out(have.length ? have.map((k) => `\`${k}\``).join(', ') : '— none');
}

// ---------- issue ----------

// Jira Software service fields with no business meaning
const NOISE_FIELDS = new Set(['Rank', 'Development', 'Epic Colour']);

function valueToText(v: Json): string | undefined {
  if (v == null || (Array.isArray(v) && v.length === 0)) return undefined;
  if (typeof v !== 'object') return String(v) === '{}' ? undefined : String(v);
  if (Array.isArray(v)) return v.map(valueToText).filter(Boolean).join(', ');
  return v.displayName ?? v.name ?? v.value ?? v.key ?? undefined;
}

/**
 * Issue → stdout and .jira/out/<KEY>/<KEY>.md. Description and comments come from renderedFields (Jira HTML → Markdown,
 * like wiki pages): headings, lists, tables, code, mentions as names. Issue images are always downloaded (so they show
 * in the .md), other attachments with withAll (--attachments); attachment links point to the local files.
 */
async function issue(jira: RestClient, key: string, withAll: boolean) {
  const lines: string[] = [];
  const add = (line = '') => lines.push(line);
  const i: Json = await jira.get(`/rest/api/2/issue/${encodeURIComponent(key)}?expand=names,renderedFields`);
  await saveRaw(`issue-${key}`, i);
  const f = i.fields;
  const dir = join(OUT_DIR, i.key);
  await mkdir(dir, { recursive: true });

  const atts: Json[] = f.attachment ?? [];
  const local = new Map<string, LocalAttachment>();
  const failed = new Map<string, string>();
  for (const a of atts.filter((a) => withAll || isImageAttachment(a))) {
    const r = await downloadAttachment(jira, a, dir);
    if ('error' in r) failed.set(a.id, r.error);
    else local.set(a.id, r);
  }
  // Same names (new file versions) — link to the newest
  const byName = new Map<string, Json>();
  for (const a of [...atts].sort((x, y) => Date.parse(x.created) - Date.parse(y.created))) byName.set(a.filename, a);
  const inlined = new Set<string>();
  const label = (s: string) => s.replace(/[[\]]/g, '\\$&');
  // Jira HTML: attachment links by id — Cloud …/attachment/content/<id>, Server /secure/attachment|thumbnail/<id>/…
  // → relative link to the downloaded file (if it was downloaded)
  const localizeHtml = (html: string) =>
    html.replace(/(src|href)="([^"]*?(?:attachment\/content\/(\d+)|\/secure\/(?:attachment|thumbnail)\/(\d+))[^"]*)"/g,
      (m, attr: string, _url: string, cloudId?: string, serverId?: string) => {
        const id = cloudId ?? serverId!;
        const l = local.get(id);
        if (!l) return m;
        if (attr === 'src') inlined.add(id);
        return `${attr}="${markdownFileLink(l.name)}"`;
      });
  // Fallback without renderedFields — raw wiki markup: !image.png! or !image.png|thumbnail,width=300!
  const wikiImages = (text: string) =>
    text.replace(/!([^!\n|]+?)(\|[^!\n]*)?!/g, (m, name: string) => {
      const a = byName.get(name.trim());
      const l = a && local.get(a.id);
      if (!l) return m;
      inlined.add(a.id);
      return `![${label(name.trim())}](${markdownFileLink(l.name)})`;
    });
  const toMarkdown = (html: unknown, raw: unknown) =>
    typeof html === 'string' && html.trim() ? htmlToMarkdown(localizeHtml(html), jira.baseUrl) : wikiImages(String(raw ?? ''));
  const rendered = i.renderedFields ?? {};
  const description = toMarkdown(rendered.description, f.description) || '_empty_';
  const comments: Json[] = f.comment?.comments ?? [];
  const renderedComments = new Map<string, string>((rendered.comment?.comments ?? []).map((c: Json) => [c.id, c.body]));
  const commentBodies = comments.map((c) => toMarkdown(renderedComments.get(c.id), c.body));

  add(`# ${i.key}: ${f.summary}\n`);
  add(`${jira.baseUrl}/browse/${i.key}\n`);
  const meta: [string, unknown][] = [
    ['Type', f.issuetype?.name],
    ['Status', f.status?.name],
    ['Priority', f.priority?.name],
    ['Assignee', f.assignee?.displayName],
    ['Reporter', f.reporter?.displayName],
    ['Created', f.created],
    ['Updated', f.updated],
    ['Parent', f.parent ? `${f.parent.key} ${f.parent.fields?.summary ?? ''}` : undefined],
    ['Labels', valueToText(f.labels)],
    ['Components', valueToText(f.components)],
    ['Fix versions', valueToText(f.fixVersions)],
  ];
  for (const [k, v] of meta) if (v) add(`- **${k}:** ${v}`);

  // Custom fields with human names, only non-empty and simple ones
  const custom = Object.entries(f)
    .filter(([id]) => id.startsWith('customfield_'))
    .map(([id, v]) => [i.names?.[id] ?? id, valueToText(v)] as const)
    .filter(([name, v]) => v && v.length < 300 && !NOISE_FIELDS.has(name));
  if (custom.length) {
    add('\n## Additional fields\n');
    for (const [name, v] of custom) add(`- **${name}:** ${v}`);
  }

  add('\n## Description\n');
  add(description);

  if (f.subtasks?.length) {
    add('\n## Subtasks\n');
    for (const s of f.subtasks) add(`- \`${s.key}\` [${s.fields.status?.name}] ${s.fields.summary}`);
  }

  if (f.issuelinks?.length) {
    add('\n## Links\n');
    for (const l of f.issuelinks) {
      const other = l.outwardIssue ?? l.inwardIssue;
      const rel = l.outwardIssue ? l.type.outward : l.type.inward;
      add(`- ${rel} \`${other.key}\` [${other.fields?.status?.name}] ${other.fields?.summary}`);
    }
  }

  try {
    const remote: Json[] = await jira.get(`/rest/api/2/issue/${encodeURIComponent(key)}/remotelink`);
    if (remote.length) {
      add('\n## Remote links (Confluence etc.)\n');
      for (const r of remote) add(`- [${r.object?.title}](${r.object?.url})${r.application?.name ? ` — ${r.application.name}` : ''}`);
    }
  } catch (e) {
    if (isFatal(e)) throw e;
  }

  if (atts.length) {
    add('\n## Attachments\n');
    for (const a of atts) {
      const info = `(${Math.round(a.size / 1024)} KB, ${a.mimeType}), ${a.author?.displayName}, ${a.created}`;
      const l = local.get(a.id);
      if (!l) {
        add(`- ${a.filename} ${info} — ${failed.has(a.id) ? `❌ ${failed.get(a.id)}` : 'not downloaded (`--attachments`)'}`);
        continue;
      }
      const docxText = l.md ? ` · text: [${label(l.md)}](${markdownFileLink(l.md)})` : '';
      add(`- [${label(a.filename)}](${markdownFileLink(l.name)}) ${info}${docxText}`);
      // Images not shown in the description / comments are shown here
      if (isImageAttachment(a) && !inlined.has(a.id)) add(`\n  ![${label(a.filename)}](${markdownFileLink(l.name)})\n`);
    }
  }

  add(`\n## Comments (${f.comment?.total ?? comments.length})\n`);
  for (const [n, c] of comments.entries()) {
    const edited = c.updated && c.updated !== c.created ? ` · edited ${c.updated}${userId(c.updateAuthor) !== userId(c.author) ?` (${c.updateAuthor?.displayName})` : ''}` : '';
    add(`### ${c.author?.displayName} — ${c.created}${edited}\n`);
    add(commentBodies[n]);
    add();
  }
  const text = lines.join('\n');
  out(text);
  const file = join(dir, `${i.key}.md`);
  await writeFile(file, text);
  await setFileTime(file, f.updated);
  out(`\nSaved: ${file}`);
}

// ---------- search ----------

async function search(jira: RestClient, jql: string, limit: number) {
  const r = await searchIssues(jira, jql, 'summary,status,assignee,issuetype,updated', limit);
  // Cloud returns no total — show "N+" if the page is full
  const found = r.total ?? `${r.issues.length}${r.issues.length === limit ? '+' : ''}`;
  out(`Found: ${found} (showing ${r.issues.length})\n`);
  out('| Key | Type | Status | Assignee | Updated | Summary |');
  out('|---|---|---|---|---|---|');
  for (const i of r.issues) {
    const f = i.fields;
    out(`| ${i.key} | ${f.issuetype?.name ?? ''} | ${f.status?.name ?? ''} | ${f.assignee?.displayName ?? '—'} | ${f.updated?.slice(0, 10)} | ${String(f.summary).replace(/\|/g, '\\|')} |`);
  }
}

// ---------- attachments ----------

const isImageAttachment = (a: Json) =>
  /^image\//.test(a.mimeType ?? '') || /\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(a.filename ?? '');

interface LocalAttachment {
  /** File name in .jira/out/<KEY>/ */
  name: string;
  /** For .docx — name of the converted .md */
  md?: string;
}

/**
 * Downloads a Jira attachment to dir as `<id>_<name>`; a .docx is also converted to .md. A file of the same size is
 * not downloaded again (Jira attachments are immutable: a new version = a new id). Returns local names or an error.
 */
async function downloadAttachment(jira: RestClient, a: Json, dir: string): Promise<LocalAttachment | { error: string }> {
  const name = `${a.id}_${safeFileName(a.filename)}`;
  const file = join(dir, name);
  const isDocx = /\.docx$/i.test(name);
  const mdName = isDocx ? name.replace(/\.docx$/i, '.md') : undefined;
  const existing = await stat(file).catch(() => undefined);
  if (!existing || existing.size !== a.size) {
    const res = await jira.raw(a.content, { accept: '*/*' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    // The attachment's upload date in Jira = the file date
    await setFileTime(file, a.created);
  }
  if (isDocx && !(await stat(join(dir, mdName!)).catch(() => undefined))) {
    const md = await docxToMarkdownFile(file);
    await setFileTime(md, a.created);
  }
  return { name, md: mdName };
}

async function attachments(jira: RestClient, key: string) {
  const i: Json = await jira.get(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=attachment`);
  const list: Json[] = i.fields.attachment ?? [];
  if (!list.length) return out(`${key} has no attachments.`);
  const dir = join(OUT_DIR, key);
  await mkdir(dir, { recursive: true });
  for (const a of list) {
    const local = await downloadAttachment(jira, a, dir);
    if ('error' in local) {
      out(`- ❌ ${a.filename}: ${local.error}`);
      continue;
    }
    out(`- ✅ ${join(dir, local.name)} (${a.author?.displayName}, ${a.created})`);
    if (local.md) out(`  - text: ${join(dir, local.md)}`);
  }
}

// ---------- track ----------

function parseTrackArgs(args: string[]): TrackOptions {
  const opts: TrackOptions = { keys: [], pages: [], remove: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--jql') opts.jql = value();
    else if (a === '--page') opts.pages.push(value());
    else if (a === '--since') opts.since = value();
    else if (a === '--remove') opts.remove.push(value());
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else opts.keys.push(a);
  }
  return opts;
}

// ---------- init ----------

/** .jira/ in the current folder: .gitignore with `*` (the whole folder stays out of git, no need to edit the project's .gitignore) and .env from env.example. */
async function init() {
  const dir = resolve('.jira');
  await mkdir(dir, { recursive: true });
  const exists = async (f: string) => !!(await stat(f).catch(() => undefined));
  const ignore = join(dir, '.gitignore');
  if (!(await exists(ignore))) await writeFile(ignore, '# atlasmd: tokens and downloaded issues — not for git\n*\n');
  const env = join(dir, '.env');
  if (await exists(env)) out(`- ${env} already exists — left untouched`);
  else {
    await copyFile(fileURLToPath(new URL('../env.example', import.meta.url)), env);
    out(`- Created ${env} — fill in the URLs and tokens`);
  }
  out(`- ${ignore}: the .jira/ folder stays out of git`);
  await installSkill();
  out('\nNext: npx --no atlasmd probe');
}

// ---------- skill ----------

// The Claude Code skill ships in the package; the project gets a copy stamped with the version. After `npm update atlasmd`
// one command (`skill`) updates the instructions for Claude, and the change shows in the project's diff. Writes only to the current folder.
const SKILL_SRC = new URL('../skills/atlasmd/SKILL.md', import.meta.url);
const SKILL_DST = resolve('.claude', 'skills', 'atlasmd', 'SKILL.md');
const SKILL_STATUS_TEXT = {
  current: `up to date (v${VERSION})`,
  outdated: `outdated or edited by hand — update: npx --no atlasmd skill`,
  missing: `not installed — npx --no atlasmd skill`,
};

// Compare ignoring CRLF/LF: git on Windows may convert line endings in either file
const normalize = (s: string) => s.replace(/\r\n/g, '\n');

function skillText(): string {
  return `${normalize(readFileSync(SKILL_SRC, 'utf8')).trimEnd()}\n\n` +
    `<!-- Generated by atlasmd v${VERSION} (npx --no atlasmd skill). Do not edit: the file is overwritten on update. -->\n`;
}

function skillStatus(): keyof typeof SKILL_STATUS_TEXT {
  if (!existsSync(SKILL_DST)) return 'missing';
  return normalize(readFileSync(SKILL_DST, 'utf8')) === skillText() ? 'current' : 'outdated';
}

async function installSkill() {
  const status = skillStatus();
  if (status === 'current') out(`- Skill ${SKILL_DST} is up to date (v${VERSION})`);
  else {
    await mkdir(dirname(SKILL_DST), { recursive: true });
    await writeFile(SKILL_DST, skillText());
    out(`- Skill ${status === 'missing' ? 'installed' : 'updated'}: ${SKILL_DST} (v${VERSION})`);
  }
  // The project's settings.json is not touched (it holds other rules too) — only a reminder if the token deny rule is missing
  const settings = resolve('.claude', 'settings.json');
  if (!existsSync(settings) || !readFileSync(settings, 'utf8').includes('.jira/.env')) {
    out(`- ⚠️ ${settings}: no rule denying access to the tokens — add to "permissions": { "deny": ["Read(/.jira/.env*)", "Edit(/.jira/.env*)"] }`);
  }
}

// ---------- main ----------

// Service commands are grouped (`jira …`, `wiki …`); commands that span both services or none stay top-level.
const JIRA_USAGE =
  '  jira issue <KEY> [--attachments]      issue → Markdown (+ all attachments)\n' +
  '  jira search "<JQL>" [N]               issue search (default 20)\n' +
  '  jira attachments <KEY>                download all issue attachments';
const WIKI_USAGE =
  '  wiki page <pageId|URL> [--attachments]           Confluence page → Markdown (+ all attachments)\n' +
  '  wiki search "<text|CQL>" [N] [--space SPACE]     page search (default 20)';
const USAGE =
  'Usage: atlasmd <command>\n\n' +
  'Jira:\n' + JIRA_USAGE + '\n\n' +
  'Confluence:\n' + WIKI_USAGE + '\n\n' +
  'Both / other:\n' +
  '  probe                                 check access to Jira and Confluence\n' +
  '  track [KEY…] [--jql "<JQL>"] [--page <pageId|URL>] [--since YYYY-MM-DD] [--remove KEY|pageId]\n' +
  '                                        changes in issues and linked wiki pages since the last run\n' +
  '  docx <file.docx>…                     local .docx → .md next to it\n' +
  '  init | skill | version                set up the project / update the Claude Code skill / tool version';

function usage(text: string) {
  out(text);
  process.exitCode = 1;
}

function confluenceClient(): RestClient {
  const confluence = loadConfluenceConfig();
  if (!confluence) throw new Error(`CONFLUENCE_BASE_URL / CONFLUENCE_TOKEN not set: ${envHint()}`);
  return new RestClient(confluence);
}

async function jiraCommand(sub: string | undefined, args: string[]) {
  if (!sub || !['issue', 'search', 'attachments'].includes(sub)) return usage(`Jira commands:\n${JIRA_USAGE}`);
  const jira = new RestClient(loadJiraConfig());
  switch (sub) {
    case 'issue':
      if (!args[0]) throw new Error('Pass an issue key, e.g. jira issue PROJ-123');
      return issue(jira, args[0].toUpperCase(), args.includes('--attachments'));
    case 'search':
      if (!args[0]) throw new Error('Pass JQL in quotes');
      return search(jira, args[0], Number(args[1] ?? 20));
    case 'attachments':
      if (!args[0]) throw new Error('Pass an issue key, e.g. jira attachments PROJ-123');
      return attachments(jira, args[0].toUpperCase());
  }
}

async function wikiCommand(sub: string | undefined, args: string[]) {
  switch (sub) {
    case 'page':
      if (!args[0]) throw new Error('Pass a pageId or page URL, e.g. wiki page 123456');
      return wikiPage(confluenceClient(), args[0], OUT_DIR, args.includes('--attachments'));
    case 'search': {
      const spaceIdx = args.indexOf('--space');
      const space = spaceIdx >= 0 ? args[spaceIdx + 1] : undefined;
      const rest = args.filter((_, i) => spaceIdx < 0 || (i !== spaceIdx && i !== spaceIdx + 1));
      if (!rest[0]) throw new Error('Pass text or CQL in quotes');
      return wikiSearch(confluenceClient(), rest[0], Number(rest[1] ?? 20), space);
    }
    default:
      return usage(`Confluence commands:\n${WIKI_USAGE}`);
  }
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  const args = process.argv.slice(3);
  switch (cmd) {
    case 'jira':
      return jiraCommand(sub, rest);
    case 'wiki':
      return wikiCommand(sub, rest);
    case 'version':
    case '--version':
    case '-v':
      return out(`atlasmd v${VERSION}`);
    case 'init':
      return init();
    case 'skill':
      return installSkill();
    case 'docx':
      // Local .docx files (e.g. specs from unpacked attachment archives) → .md next to them, images as files.
      if (!args.length) throw new Error('Pass the .docx path(s)');
      for (const file of args) out(`- ${await docxToMarkdownFile(file)}`);
      return;
    case 'probe':
      return probe(new RestClient(loadJiraConfig()));
    case 'track': {
      const confluence = loadConfluenceConfig();
      return track(new RestClient(loadJiraConfig()), confluence && new RestClient(confluence), parseTrackArgs(args), OUT_DIR);
    }
    default:
      return usage(cmd ? `Unknown command "${cmd}".\n\n${USAGE}` : USAGE);
  }
}

// exitCode instead of process.exit(): exit() with open HTTP connections on Windows (Node 24) crashes
// with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)".
main().catch((e) => {
  console.error(`\n⛔ ${(e as Error).message}`);
  process.exitCode = 1;
});
