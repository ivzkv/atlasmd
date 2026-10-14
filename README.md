# atlasmd

**English** · [Українська](README.uk.md) · [Русский](README.ru.md)

**Give your coding agent safe, read-only access to Jira and Confluence.**

atlasmd is a small CLI that turns Jira issues and Confluence pages into clean Markdown files an AI agent can read.
It was built for agents first (with a ready-made [Claude Code](https://claude.com/claude-code) skill), and it is
just as usable by hand. Works with self-hosted Server/Data Center and Atlassian Cloud.

## Why atlasmd

- **Read-only by design.** There is no write operation to Jira or Confluence at all — you can let an agent use it
  without worrying that it closes an issue or edits a page.
- **Markdown, not JSON.** An issue or page becomes clean Markdown — tables, code, mentions as names, comments with
  authors and dates — instead of thousands of tokens of raw REST response.
- **Files the agent can come back to.** Everything is saved under predictable paths (`.atlasmd/out/<KEY>/<KEY>.md`),
  so the agent re-reads a file instead of repeating the request.
- **Images and attachments, locally.** Images are downloaded and linked relatively, so a multimodal agent can see
  them; `.docx` attachments are converted to `.md`.
- **Secrets stay out of the context.** Tokens are never printed; the bundled skill and a deny rule keep the agent
  away from `.atlasmd/.env`.
- **Fails fast, never retries.** On 401, CAPTCHA or an SSO redirect it stops at once — an agent in a loop cannot
  lock the account with repeated attempts.
- **Errors tell the next step.** Errors include the exact path and the command to run
  (`… or create it: node .atlasmd/tool/bin/atlasmd.js init`), so the agent can fix things on its own.
- **"What changed?" built in.** `track` reports what changed in issues and their linked wiki pages since the last
  run or a date — a ready answer to one of the most common questions.
- **Ships its own Claude Code skill.** The agent instructions come with the package, match its version, install with
  one command, and `probe` tells you when they are outdated.

## What it looks like

```
> what is in PROJ-123 and what changed since yesterday?

$ node .atlasmd/tool/bin/atlasmd.js jira issue PROJ-123
$ node .atlasmd/tool/bin/atlasmd.js track PROJ-123 --since 2026-10-13
→ the agent reads .atlasmd/out/PROJ-123/PROJ-123.md and the track report, and answers
```

## Quick start

Requires Node ≥ 23.8, git and npm. Run from the root of your project:

```
git -c advice.detachedHead=false clone -q --depth 1 --branch vX.Y.Z https://github.com/ivzkv/atlasmd.git .atlasmd/tool
npm ci --omit=dev --ignore-scripts --prefix .atlasmd/tool
node .atlasmd/tool/bin/atlasmd.js init
node .atlasmd/tool/bin/atlasmd.js probe
```

1. fetch the source of tag `vX.Y.Z` into `.atlasmd/tool/`;
2. install its runtime dependencies there (no build: the source runs directly through Node's type stripping);
3. create `.atlasmd/.env`, pin `vX.Y.Z` in `.atlasmd/version`, install the skill;
4. fill in your URLs and token in `.atlasmd/.env`;
5. check access.

`vX.Y.Z` is a release tag (see [Releases](https://github.com/ivzkv/atlasmd/releases)). Nothing is installed in the
project itself — no package.json or node_modules in its root: the tool lives in `.atlasmd/tool/` (out of git), and
`.atlasmd/version` (one line, e.g. `1.0.3`) pins its version. Commit `.atlasmd/version`, `.atlasmd/.gitignore` and the skill:
everyone on the project gets the same version — Claude fetches `.atlasmd/tool/` itself on first use (steps 1–2, the
skill describes them) — and each person runs `init` once and fills in their own token.

Everything lives in the project; `.atlasmd/` has its own `.gitignore` that keeps everything except the version pin
out of git (the project's `.gitignore` needs no changes):

```
<project root>/.atlasmd/version  pinned tool version      (committed)
<project root>/.atlasmd/tool/    the tool at that version (fetched by each person)
<project root>/.atlasmd/.env     URLs and tokens          (other path — JIRA_ENV_FILE)
<project root>/.atlasmd/out/     issues, wiki, track      (other path — JIRA_OUT_DIR)
```

The tool reads `.atlasmd/` only in the current folder and does not search parent folders — run it from the project
root (from another folder you get an error with the exact path). `probe` prints which files are used.

## Using with Claude Code

- `skill` (also run by `init`) pins the project to the version that runs it (`.atlasmd/version`) and installs that
  version's `.claude/skills/atlasmd/SKILL.md`. The skill tells Claude when and how to use the tool, how to handle
  failures, and what never to touch. It holds no version — it is `skills/atlasmd/SKILL.md` from this repository as is,
  so in a project it changes only when its text changes here.
- To move the project to another version (or ask Claude to do it): write it to `.atlasmd/version`, delete
  `.atlasmd/tool/`, fetch again (steps 1–2), run `skill`, commit the diff. Until the copy is fetched again, every
  command warns that the pin and the running version differ; `probe` prints both and whether the skill matches.
- Deny Claude access to the tokens in the project's `.claude/settings.json`:
  `"permissions": { "deny": ["Read(/.atlasmd/.env*)", "Edit(/.atlasmd/.env*)"] }`. `skill` reminds you if the rule is missing.

Other agents can use the same commands — any agent that can run a shell command and read a file works.

## Commands

`atlasmd` below is short for `node .atlasmd/tool/bin/atlasmd.js` (run from the project root).

```
atlasmd jira issue PROJ-123                         # issue: fields, description, comments, links (incl. wiki) → stdout and .atlasmd/out/PROJ-123/PROJ-123.md;
                                                    #   issue images are downloaded and shown in the .md (in place in the description/comments)
atlasmd jira issue PROJ-123 --attachments           # the same + all attachments next to it, linked from the .md (.docx → also .md)
atlasmd jira search "project = PROJ AND resolution = Unresolved" 50
atlasmd jira attachments PROJ-123                   # attachments to .atlasmd/out/PROJ-123/, .docx → also .md (.docx images as files next to it)

atlasmd wiki page 123456                            # wiki page → Markdown + comments (inline ones with the selected text)
atlasmd wiki page "https://wiki.example.com/spaces/SPACE/pages/123456/..." --attachments   # page images are always downloaded, --attachments adds the rest
atlasmd wiki search "release notes" 30 --space SPACE   # wiki page search: text or ready CQL
atlasmd wiki search "title ~ release" --cql          # CQL is detected by a "field operator" condition (title = …, text ~ …);
                                                    #   --cql / --text force the mode; your own ORDER BY in CQL is kept

atlasmd probe                                       # version, user, permissions, projects, boards, fields, attachments, Confluence
atlasmd docx "<path>.docx"                          # local .docx → .md next to it (e.g. specs from attachment archives)
atlasmd init                                        # set up the project: .atlasmd/.env, .atlasmd/.gitignore, Claude Code skill
atlasmd skill                                       # install / update .claude/skills/atlasmd/SKILL.md from this version
atlasmd version                                     # tool version (also in the first line of probe)
```

`atlasmd jira` or `atlasmd wiki` without a subcommand prints that group's commands. `wiki page` accepts a pageId,
`viewpage.action?pageId=…`, `/spaces/X/pages/<id>/…` or `/display/SPACE/Title`; the result goes to stdout and to
`.atlasmd/out/wiki/<pageId>/`.

Dates: the output includes comment creation and edit dates, wiki versions and attachment dates. Downloaded files get
the real date from Jira (attachment upload date) / Confluence (version date) on disk, not the download time.

## Change tracking (`track`)

```
atlasmd track PROJ-123 PROJ-456                     # start tracking / check these issues
atlasmd track --jql "project = PROJ AND status = \"In Progress\""
atlasmd track --page 123456                         # a single wiki page without an issue
atlasmd track                                       # check everything that is tracked
atlasmd track PROJ-123 --since 2026-01-31           # changes since a date (works without a previous snapshot too)
atlasmd track --remove PROJ-456                     # stop tracking
```

The first run records a baseline; the following runs show what changed since the previous one:

- **Jira** — from the issue changelog (every field change with author and date; long fields such as the description
  as a diff), comments new / edited (diff against the snapshot) / deleted, new and removed links to wiki pages.
- **Wiki** — pages the issue links to (remote links + URLs in the description and comments), or pages given with
  `--page`: all new versions (who, when, version message; skipped numbers = deleted/merged in Confluence history),
  a text diff between versions fetched from Confluence itself (from the snapshot if the old version was deleted),
  word-level "before → after" for edits inside long lines; comments new / edited / resolved↔open / deleted;
  attachments new / new version / deleted.

Snapshot — `.atlasmd/out/track/state.json`, reports — `.atlasmd/out/track/reports/<date_time>.md`.
Dynamic parts of the Jira macro in wiki pages (issue title/status) are ignored when comparing.

### Limitations

- What was deleted **before** tracking started cannot be recovered: Confluence deletes/merges page versions itself
  (version numbers may be missing in page history), and Jira does not keep deleted comments.
- The old text of an edited Jira comment is available only if the comment was already in the snapshot (Jira keeps
  only the edit date); with `--since` and no snapshot you see what changed and when, and the current text.
- A deleted Jira comment is visible only between `track` runs (not via `--since`).
- The API does not tell who viewed an issue or page.
- `track` does not run on its own — call it whenever you sync.

## Configuration

`.atlasmd/.env` (created by `init` from [env.example](env.example)) — one of the options; Jira and
Confluence may differ:

- **Server/DC:** `JIRA_BASE_URL` + `JIRA_TOKEN`, `CONFLUENCE_BASE_URL` + `CONFLUENCE_TOKEN` — separate PATs from the
  Jira and Confluence profiles, `Authorization: Bearer`. Do not set an email.
- **Cloud:** URLs are used exactly as given — `JIRA_BASE_URL=https://<site>.atlassian.net`,
  `CONFLUENCE_BASE_URL=https://<site>.atlassian.net/wiki`; `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` — one token
  from id.atlassian.com → Security → API tokens for both services, `Authorization: Basic`. Access is exactly what
  this account has in the browser.
- The mode is detected like this: an email is set (`<SERVICE>_EMAIL` / `ATLASSIAN_EMAIL`) → basic, otherwise bearer;
  to force it — `JIRA_AUTH` / `CONFLUENCE_AUTH` = `bearer` | `basic`. `probe` prints the mode in use.

Variables already set in the process environment take precedence over `.env` (handy for CI).

HTTPS trusts certificates from the OS store (`--use-system-ca`). `JIRA_INSECURE_TLS=1` is for self-hosted servers
only, when the chain ends in a corporate root CA missing even there; it disables TLS verification for this process only.

<details>
<summary>Cloud differences the client handles itself</summary>

JQL search via `/rest/api/3/search/jql` (the old `/rest/api/2/search` is disabled on Cloud; no `total` is returned —
search shows "N+", probe counts use `approximate-count`), users have an `accountId` instead of `name`/`username`.
Base URLs are never rewritten.

</details>

## Security

- No write requests to Jira or Confluence — only reads.
- On 401, a redirect to SSO/login, or CAPTCHA the client stops at once, without retries (self-hosted Jira locks
  REST behind CAPTCHA after repeated 401s).
- Tokens are never logged. If a token leaks, revoke it in the Jira/Confluence profile → Personal Access Tokens
  (Server/DC) or at id.atlassian.com → Security → API tokens (Cloud; one token opens both services).

## Development

```
npm install                    # also builds dist/ (prepare)
npm run dev -- jira issue X-1  # run from src/*.ts without building (Node's native type stripping)
npm run typecheck
npm run build                  # dist/ — the built package; a source checkout (this repo, .atlasmd/tool) runs src/ directly
```

To try local changes in a project, run the working copy from the project root (it runs `src/` directly, no build;
the project's `.atlasmd/tool/` stays as is):

```
node <path to atlasmd>/bin/atlasmd.js jira issue X-1
```

Dependencies are only Markdown converters: `turndown` (+ gfm for
tables) and `mammoth` for `.docx`.

## Releases

Versions are git tags `vX.Y.Z`; `version` in package.json is what `atlasmd version` and `probe` print. Tags are
created by CI — do not tag by hand:

```
npm version minor --no-git-tag-version    # or patch / major; updates package.json and package-lock.json
git commit -am "Release 1.1.0" && git push
git push origin main:release              # .github/workflows/release.yml: checks → tag v1.1.0 + GitHub Release
```

The workflow fails without publishing anything if the tag already exists (the version was not bumped) or the checks
fail. In projects: the new version in `.atlasmd/version`, fetch `.atlasmd/tool/` again, `skill`, commit `.atlasmd/version` and the skill. Breaking changes (commands,
`.atlasmd/.env` format) only in a new major version.

## License

[MIT](LICENSE)
