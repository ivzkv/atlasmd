// Confluence (Server/DC and Cloud): page → Markdown + comments (incl. inline ones with the selected text) + attachments.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RestClient, userId } from './client.ts';
import { OUT_DIR } from './paths.ts';
import { docxToMarkdownFile, htmlToMarkdown, safeFileName, setFileTime } from './convert.ts';

type Json = any;

const out = (line = '') => console.log(line);

/** Accepts a pageId, viewpage.action?pageId=…, /spaces/X/pages/<id>/…, /display/SPACE/Title. */
export async function resolvePageId(wiki: RestClient, ref: string): Promise<string> {
  if (/^\d+$/.test(ref)) return ref;
  const byParam = ref.match(/[?&]pageId=(\d+)/);
  if (byParam) return byParam[1];
  const byPath = ref.match(/\/pages\/(\d+)(?:\/|$|\?)/);
  if (byPath) return byPath[1];
  const display = ref.match(/\/display\/([^/?#]+)\/([^?#]+)/);
  if (display) {
    const title = decodeURIComponent(display[2].replace(/\+/g, ' '));
    const found: Json = await wiki.get(
      `/rest/api/content?spaceKey=${encodeURIComponent(display[1])}&title=${encodeURIComponent(title)}`,
    );
    if (found.results?.[0]) return found.results[0].id;
    throw new Error(`Page "${title}" not found in space ${display[1]}`);
  }
  throw new Error(`Could not determine a pageId from "${ref}"`);
}

/** A comment was edited if its version > 1; the last edit date is version.when. */
export function commentEditedAt(c: Json): string | undefined {
  return c.version?.number > 1 ? c.version.when : undefined;
}

/**
 * All items of a Confluence list. The end is detected by `_links.next`, not by `size < limit`: the server may return
 * a smaller page than requested (its own maximum limit), and the rest would then be lost silently.
 */
export async function fetchAll(wiki: RestClient, path: string): Promise<Json[]> {
  const limit = 100;
  const all: Json[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let start = 0; ; ) {
    const page: Json = await wiki.get(`${path}${sep}limit=${limit}&start=${start}`);
    const results: Json[] = page.results ?? [];
    all.push(...results);
    // Without _links (an unusual response) — fallback: a full page means there may be more
    const more = page._links ? Boolean(page._links.next) : results.length >= limit;
    if (!more || !results.length) return all;
    start += results.length;
  }
}

const isImage = (a: Json) =>
  /^image\//.test(a.extensions?.mediaType ?? '') || /\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(a.title ?? '');

// CQL = at least one "field operator …" condition (title = …, text ~ …, created > …, label in (…)), not just any `=`/`~` in the text
const CQL_CONDITION_RE =
  /\b(type|space|title|text|label|ancestor|parent|id|content|creator|contributor|mention|created|lastmodified|favourite|watcher|macro|siteSearch)(\.\w+)?\s*(!?=|!?~|[<>]=?|\s(not\s+)?in\s*\()/i;

const ORDER_BY_RE = /\s+order\s+by\s+.*$/i;

export type WikiSearchMode = 'auto' | 'cql' | 'text';

/**
 * Wiki page search. [query] is either ready CQL or plain text → `type = page AND text ~ "…"`; [mode] auto
 * detects CQL by a "field operator" condition, `--cql`/`--text` set it explicitly. An ORDER BY in the query is kept,
 * otherwise results are sorted by modification date. [space] limits the search to a space key (e.g. SPACE).
 * Output is a table: pageId, space, updated, path › title.
 */
export async function wikiSearch(wiki: RestClient, query: string, limit: number, space?: string, mode: WikiSearchMode = 'auto') {
  const isCql = mode === 'cql' || (mode === 'auto' && CQL_CONDITION_RE.test(query));
  const base = isCql ? query.trim() : `type = page AND text ~ "${query.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  // ORDER BY may only end the whole query: when wrapping in parentheses (space = … AND (…)) it has to be moved out
  const orderBy = ORDER_BY_RE.exec(base)?.[0].trim();
  const condition = base.replace(ORDER_BY_RE, '');
  const cql = space ? `space = "${space}" AND (${condition})` : condition;
  const full = `${cql} ${orderBy ?? 'ORDER BY lastmodified DESC'}`;
  const r: Json = await wiki.get(
    `/rest/api/content/search?limit=${limit}&expand=space,version,ancestors&cql=${encodeURIComponent(full)}`,
  );
  const results: Json[] = r.results ?? [];
  out(`CQL: ${full}`);
  out(`Found: ${r.totalSize ?? results.length} (showing ${results.length})\n`);
  out('| pageId | Space | Updated | By | Page |');
  out('|---|---|---|---|---|');
  for (const c of results) {
    const path = [...(c.ancestors ?? []).slice(1).map((a: Json) => a.title), c.title].join(' › ').replace(/\|/g, '\\|');
    out(`| ${c.id} | ${c.space?.key ?? ''} | ${c.version?.when?.slice(0, 10) ?? ''} | ${c.version?.by?.displayName ?? ''} | ${path} |`);
  }
}

export async function wikiPage(wiki: RestClient, ref: string, outDir: string, withAttachments: boolean) {
  const id = await resolvePageId(wiki, ref);
  const page: Json = await wiki.get(`/rest/api/content/${id}?expand=body.view,version,space,ancestors,history`);
  const lines: string[] = [];
  const add = (line = '') => lines.push(line);

  add(`# ${page.title}\n`);
  add(`${wiki.baseUrl}/pages/viewpage.action?pageId=${id}\n`);
  add(`- **Space:** ${page.space?.key} — ${page.space?.name}`);
  add(`- **Path:** ${page.ancestors?.map((a: Json) => a.title).join(' › ') || '—'}`);
  add(`- **Version:** ${page.version?.number}, ${page.version?.by?.displayName}, ${page.version?.when}`);
  add(`- **Author:** ${page.history?.createdBy?.displayName}, ${page.history?.createdDate}`);

  add('\n---\n');
  add(htmlToMarkdown(page.body?.view?.value ?? '', wiki.baseUrl));

  const children = await fetchAll(wiki, `/rest/api/content/${id}/child/page`);
  if (children.length) {
    add('\n---\n\n## Child pages\n');
    for (const c of children) add(`- ${c.title} (pageId ${c.id})`);
  }

  const comments = await fetchAll(
    wiki,
    `/rest/api/content/${id}/child/comment?depth=all&expand=body.view,history,version,ancestors,extensions.inlineProperties,extensions.resolution`,
  );
  if (comments.length) {
    add(`\n---\n\n## Comments (${comments.length})\n`);
    const ids = new Set(comments.map((c) => c.id));
    const parentOf = (c: Json) => [...(c.ancestors ?? [])].reverse().find((a: Json) => ids.has(a.id))?.id;
    const replies = new Map<string, Json[]>();
    for (const c of comments) {
      const p = parentOf(c);
      if (p) replies.set(p, [...(replies.get(p) ?? []), c]);
    }
    const render = (c: Json, depth: number) => {
      const indent = '> '.repeat(depth);
      const inline = c.extensions?.location === 'inline';
      const status = c.extensions?.resolution?.status;
      const edited = commentEditedAt(c);
      const header =
        `${c.history?.createdBy?.displayName} — ${c.history?.createdDate}` +
        `${edited ? ` · edited ${edited}` : ''}${inline ? ' · inline' : ''}${status ? ` · ${status}` : ''}`;
      add(`${indent}**${header}**`);
      const selection = c.extensions?.inlineProperties?.originalSelection;
      if (selection && depth === 0) add(`${indent}_On text:_ "${selection}"`);
      for (const l of htmlToMarkdown(c.body?.view?.value ?? '', wiki.baseUrl).split('\n')) add(`${indent}${l}`);
      add(indent.trimEnd());
      for (const r of replies.get(c.id) ?? []) render(r, depth + 1);
    };
    for (const c of comments.filter((c) => !parentOf(c))) {
      render(c, 0);
      add();
    }
  }

  const attachments = await fetchAll(wiki, `/rest/api/content/${id}/child/attachment?expand=version`);
  const dir = join(outDir, 'wiki', id);
  if (attachments.length) {
    add(`\n---\n\n## Attachments (${attachments.length})\n`);
    for (const a of attachments) {
      const size = a.extensions?.fileSize ? `${Math.round(a.extensions.fileSize / 1024)} KB` : '';
      add(`- ${a.title} (${size}, ${a.extensions?.mediaType ?? ''}) — v${a.version?.number}, ${a.version?.by?.displayName}, ${a.version?.when}`);
    }
    // Images are always downloaded — the page text links to them (`![…](file)`); without the files
    // Markdown shows only their names. Other attachments only with --attachments.
    const toDownload = attachments.filter((a) => withAttachments || isImage(a));
    if (toDownload.length) {
      await mkdir(dir, { recursive: true });
      add();
      for (const a of toDownload) {
        const res = await wiki.raw(a._links.download, { accept: '*/*' });
        if (!res.ok) {
          add(`- ❌ ${a.title}: HTTP ${res.status}`);
          continue;
        }
        const file = join(dir, safeFileName(a.title));
        await writeFile(file, Buffer.from(await res.arrayBuffer()));
        await setFileTime(file, a.version?.when);
        add(`- ✅ ${file}`);
        if (/\.docx$/i.test(file)) {
          const md = await docxToMarkdownFile(file);
          await setFileTime(md, a.version?.when);
          add(`  - text: ${md}`);
        }
      }
    }
  }

  await mkdir(dir, { recursive: true });
  const mdFile = join(dir, `${safeFileName(page.title)}.md`);
  await writeFile(mdFile, lines.join('\n'));
  await setFileTime(mdFile, page.version?.when);
  out(lines.join('\n'));
  out(`\nSaved: ${mdFile}`);
}

export async function probeConfluence(wiki: RestClient, saveRaw: (name: string, data: unknown) => Promise<void>) {
  const me: Json = await wiki.get('/rest/api/user/current');
  await saveRaw('confluence-user', me);
  out(`- Auth: ${wiki.authLabel}; platform: ${wiki.cloud ? 'Cloud' : 'Server/DC'}`);
  out(`- User: ${me.displayName} (\`${userId(me)}\`)`);
  const spaces = await fetchAll(wiki, '/rest/api/space?type=global');
  await saveRaw('confluence-spaces', spaces);
  out(`- Visible global spaces: **${spaces.length}**`);
  for (const s of spaces.slice(0, 40)) out(`  - \`${s.key}\` — ${s.name}`);
  if (spaces.length > 40) out(`  - … ${spaces.length - 40} more (${join(OUT_DIR, 'raw', 'confluence-spaces.json')})`);
}
