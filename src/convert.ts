// Converts HTML (Jira fields, Confluence pages) and .docx (spec attachments) to Markdown.

import { readFile, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import mammoth from 'mammoth';
import { createPatch, diffWords, structuredPatch } from 'diff';

// Unicode word boundaries — the default diff tokenizer splits non-Latin (e.g. Cyrillic) words in the middle
const wordSegmenter = new Intl.Segmenter('uk', { granularity: 'word' });

export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

/**
 * Relative Markdown link to a local file: URL-encoding (spaces, non-ASCII, parentheses) instead of
 * `<…>` — some viewers do not understand the angle-bracket form and show only the alt text.
 */
export function markdownFileLink(fileName: string): string {
  return encodeURIComponent(fileName).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** File modification time on disk = the real date from Jira/Confluence, not the download time. */
export async function setFileTime(path: string, iso: string | undefined) {
  const date = iso ? new Date(iso) : undefined;
  if (date && !Number.isNaN(date.getTime())) await utimes(path, date, date);
}

/** Line diff in unified format (without file headers); empty string if the texts are equal. */
export function textDiff(before: string, after: string, context = 3): string {
  if (before === after) return '';
  const patch = createPatch('x', `${before.trimEnd()}\n`, `${after.trimEnd()}\n`, '', '', { context });
  return patch.split('\n').slice(4).join('\n').trimEnd();
}

/**
 * Small changes inside long lines (a table row, a paragraph): a line diff shows the whole line,
 * so a tiny edit is hard to spot. For "removed → added" line pairs we compute a word diff and
 * return "before → after" fragments with a little context.
 */
export function wordChanges(before: string, after: string, context = 30): string[] {
  const result: string[] = [];
  const patch = structuredPatch('x', 'x', `${before.trimEnd()}\n`, `${after.trimEnd()}\n`, '', '', { context: 0 });
  for (const hunk of patch.hunks) {
    const removed = hunk.lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
    const added = hunk.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
    if (removed.length !== added.length) continue; // added/removed lines are already visible in the diff
    for (let i = 0; i < removed.length; i++) {
      const parts = diffWords(removed[i], added[i], { intlSegmenter: wordSegmenter });
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        if (!part.added && !part.removed) continue;
        // An adjacent "removed + added" pair = a replacement
        const next = parts[p + 1];
        const replaced = part.removed && next?.added;
        const was = part.removed ? part.value : '';
        const now = replaced ? next.value : part.added ? part.value : '';
        const left = (parts[p - 1] && !parts[p - 1].added && !parts[p - 1].removed ? parts[p - 1].value : '').slice(-context);
        const afterIdx = replaced ? p + 2 : p + 1;
        const right = (parts[afterIdx] && !parts[afterIdx].added && !parts[afterIdx].removed ? parts[afterIdx].value : '').slice(0, context);
        result.push(`…${left}[-${was}-]{+${now}+}${right}…`);
        if (replaced) p++;
      }
    }
  }
  return result;
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.use(gfm);
turndown.remove(['script', 'style', 'noscript']);

// Confluence tables have paragraphs/lists in cells, colspan, and often no header row —
// the gfm plugin either breaks them or leaves raw HTML. So we build the table ourselves: cell → one-line
// Markdown (line breaks → <br>), colspan → empty cells, the first row is always the header.
// A table inside a cell cannot be a Markdown table — its rows become cell lines "cell — cell" (via <br>).
// Each cell is converted by a separate turndown call, so nesting is not visible from the DOM — we track the depth ourselves.
let tableDepth = 0;

turndown.addRule('confluenceTable', {
  filter: 'table',
  replacement: (_content, node) => {
    const table = node as HTMLTableElement;
    const nested = tableDepth > 0;
    const rows: string[][] = [];
    const sections = Array.from(table.children);
    const trs = sections.flatMap((s) => (s.nodeName === 'TR' ? [s] : Array.from(s.children).filter((c) => c.nodeName === 'TR')));
    for (const tr of trs) {
      const row: string[] = [];
      for (const cell of Array.from(tr.children).filter((c) => c.nodeName === 'TD' || c.nodeName === 'TH')) {
        tableDepth++;
        let text: string;
        try {
          text = turndown.turndown((cell as HTMLElement).innerHTML).trim();
        } finally {
          tableDepth--;
        }
        // Nested: the outer table escapes `|`; line breaks inside the cell become spaces so a row stays one line
        row.push(nested ? text.replace(/\s*\n+\s*/g, ' ') : text.replace(/\n+/g, '<br>').replace(/\|/g, '\\|'));
        if (nested) continue; // no colspan needed in a "cell — cell" line
        const span = Number(cell.getAttribute('colspan') ?? 1);
        for (let i = 1; i < span; i++) row.push('');
      }
      if (row.some((c) => c)) rows.push(row);
    }
    if (!rows.length) return '';
    if (nested) return `\n\n${rows.map((r) => r.filter((c) => c).join(' — ')).join('\n')}\n\n`;
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
    return `\n\n${line(rows[0])}\n|${' --- |'.repeat(width)}\n${rows.slice(1).map(line).join('\n')}\n\n`;
  },
});

// Jira {noformat}/{code} and the Confluence code macro render as <pre> without <code> (often highlighted in <span>s) —
// the standard turndown rule misses such blocks. The language comes from class code-<lang> (Jira) or brush: <lang> (Confluence).
turndown.addRule('preWithoutCode', {
  filter: (node) => node.nodeName === 'PRE' && !node.querySelector('code'),
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const lang = /code-(\w+)/.exec(el.className)?.[1] ?? /brush:\s*(\w+)/.exec(el.getAttribute('data-syntaxhighlighter-params') ?? '')?.[1] ?? '';
    const text = (el.textContent ?? '').replace(/\n+$/, '');
    const fence = text.includes('```') ? '~~~' : '```';
    return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
  },
});

// Jira monospace ({{…}} → <tt>) is inline code; the text is taken as is, without Markdown escaping
turndown.addRule('teletype', {
  filter: (node) => node.nodeName === 'TT',
  replacement: (_content, node) => {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ');
    if (!text.trim()) return text;
    const tick = text.includes('`') ? '``' : '`';
    return `${tick}${text}${tick}`;
  },
});

// Jira issue-type icons, emoticons and macro service images are noise. Embedded page images become
// links to a file with the same name as after `wiki page --attachments`.
turndown.addRule('confluenceImage', {
  filter: 'img',
  replacement: (_content, node) => {
    const img = node as HTMLImageElement;
    const src = img.getAttribute('src') ?? '';
    if (/\/images\/icons\/|emoticon|\/plugins\/servlet\//.test(src) || src.startsWith('data:')) return '';
    const name = img.getAttribute('data-linked-resource-default-alias') ?? decodeURIComponent(src.split('?')[0].split('/').pop() ?? '');
    return name ? `![${name}](${markdownFileLink(safeFileName(name))})` : '';
  },
});

/**
 * baseUrl — turns relative wiki links (/spaces/…, /download/…) into absolute ones.
 * stable — for version comparison: drop the dynamic parts of the Jira issue macro (issue title and status that
 * Confluence pulls from Jira at render time), otherwise every issue change would look like a spec edit.
 * The "Getting issue details..." placeholder (the macro had no Jira data yet) is always removed.
 */
export function htmlToMarkdown(html: string, baseUrl?: string, options: { stable?: boolean } = {}): string {
  let source = baseUrl ? html.replace(/href="\//g, `href="${baseUrl}/`) : html;
  source = source.replace(/\s*-?\s*Getting issue details\.\.\./g, '');
  if (options.stable) {
    source = source
      .replace(/<span[^>]*class="[^"]*aui-lozenge[^"]*"[^>]*>[^<]*<\/span>/g, '')
      .replace(/(<\/a>)\s*-\s*<span class="summary">[^<]*<\/span>/g, '$1');
  }
  return turndown.turndown(source).replace(/\n{3,}/g, '\n\n').trim();
}

/** .docx → .md next to the file (images as separate files next to it). Returns the .md path. */
export async function docxToMarkdownFile(docxPath: string): Promise<string> {
  // Images from the .docx become separate files next to the .md (`<name>_img<N>.<ext>`), linked from the text.
  const base = basename(docxPath).replace(/\.docx$/i, '');
  let n = 0;
  const { value: html } = await mammoth.convertToHtml(
    { buffer: await readFile(docxPath) },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const ext = (image.contentType?.split('/')[1] ?? 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
        const name = safeFileName(`${base}_img${++n}.${ext}`);
        await writeFile(join(dirname(docxPath), name), Buffer.from(await image.readAsBase64String(), 'base64'));
        return { src: name, 'data-linked-resource-default-alias': name } as { src: string };
      }),
    },
  );
  const mdPath = docxPath.replace(/\.docx$/i, '.md');
  await writeFile(mdPath, htmlToMarkdown(html));
  return mdPath;
}
