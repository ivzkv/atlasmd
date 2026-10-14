# atlasmd — Jira / Confluence → Markdown (read-only CLI)

**English** · [Українська](README.uk.md) · [Русский](README.ru.md)

Reads Jira issues and Confluence (wiki) pages through the REST API — both self-hosted Server/Data Center (Personal
Access Token) and Atlassian Cloud (`*.atlassian.net`, API token + email) — and saves them as Markdown.
It never changes anything in Jira or Confluence.

Requires Node ≥ 23.8. Dependencies are only Markdown converters: `turndown` (+ gfm for tables) for wiki pages and
`mammoth` for `.docx`.

## Adding it to a project

Install it as a dev dependency of the project — after `git clone` + `npm install` everyone working on the project has it:

```
npm i -D "git+https://<git-host>/<owner>/atlasmd.git#semver:^1.0.0"   # built on install (prepare)
```

While developing atlasmd itself, link the local copy instead (nothing is written to the project's package.json):

```
cd atlasmd && npm install && npm link       # once
cd <project> && npm link atlasmd            # repeat after every npm install / npm ci in the project
```

Run it as `npx --no atlasmd <command>`. Keep `--no`: without it, if the package is not installed, npx downloads
whatever public npm package has that name.

Each person working on the project runs, once, from the project root:

```
npx --no atlasmd init     # creates .jira/.env from the template, .jira/.gitignore ("*") and the Claude Code skill
```

then fills in their tokens in `.jira/.env` and checks access with `npx --no atlasmd probe`.

Settings and results live in the project, not in the package:

```
<project root>/.jira/.env    URLs and tokens          (other path — JIRA_ENV_FILE)
<project root>/.jira/out/    issues, wiki, track      (other path — JIRA_OUT_DIR)
```

Commands run from the project root: the tool reads `.jira/` only in the current folder and does not search parent
folders (from another folder you get an error with the exact path). Another path can only be set explicitly:
`JIRA_ENV_FILE`, `JIRA_OUT_DIR`. `probe` prints which files are used. The whole `.jira/` folder stays out of git
thanks to its own `.gitignore`, so the project's `.gitignore` needs no changes.

### Claude Code

- `npx --no atlasmd skill` (also run by `init`) puts `.claude/skills/atlasmd/SKILL.md` from the installed package
  version into the project. After `npm update atlasmd`, run it again and commit the diff. `probe` shows whether
  the skill is up to date.
- Deny Claude access to the tokens in the project's `.claude/settings.json`:
  `"permissions": { "deny": ["Read(/.jira/.env*)", "Edit(/.jira/.env*)"] }`. `skill` reminds you if the rule is missing.

## Configuration

1. Fill in `.jira/.env` (created by `npx --no atlasmd init`) with one of the options (Jira and Confluence may differ):
   - **Server/DC:** `JIRA_BASE_URL` + `JIRA_TOKEN`, `CONFLUENCE_BASE_URL` + `CONFLUENCE_TOKEN` — separate PATs from the
     Jira and Confluence profiles, `Authorization: Bearer`. Do not set an email.
   - **Cloud:** URLs are used exactly as given — `JIRA_BASE_URL=https://<site>.atlassian.net`,
     `CONFLUENCE_BASE_URL=https://<site>.atlassian.net/wiki`; `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` — one token
     from id.atlassian.com → Security → API tokens for both services, `Authorization: Basic`. Access is exactly what
     this account has in the browser.
   - The mode is detected like this: an email is set (`<SERVICE>_EMAIL` / `ATLASSIAN_EMAIL`) → basic, otherwise bearer;
     to force it — `JIRA_AUTH` / `CONFLUENCE_AUTH` = `bearer` | `basic`. `probe` prints the mode in use.

   Variables already set in the process environment take precedence over `.env` (handy for CI).
2. HTTPS trusts certificates from the OS store (`--use-system-ca`). `JIRA_INSECURE_TLS=1` is for self-hosted servers
   only, when the chain ends in a corporate root CA missing even there. The flag disables TLS verification for this
   process only.
3. Check access: `npx --no atlasmd probe`.

Cloud differences the client handles itself: JQL search via `/rest/api/3/search/jql` (the old `/rest/api/2/search`
is disabled on Cloud; no `total` is returned — search shows "N+", probe counts use `approximate-count`), users have
an `accountId` instead of `name`/`username`. Base URLs are never rewritten.

## Commands

```
atlasmd version                                     # tool version (also in the first line of probe); not --version: npx intercepts it
atlasmd init                                        # set up the project: .jira/.env, .jira/.gitignore, Claude Code skill
atlasmd skill                                       # install / update .claude/skills/atlasmd/SKILL.md from this version
atlasmd probe                                       # version, user, permissions, projects, boards, fields, attachments, Confluence

atlasmd jira issue PROJ-123                         # issue: fields, description, comments, links (incl. wiki) → stdout and .jira/out/PROJ-123/PROJ-123.md;
                                                    #   issue images are downloaded and shown in the .md (in place in the description/comments)
atlasmd jira issue PROJ-123 --attachments           # the same + all attachments next to it, linked from the .md (.docx → also .md)
atlasmd jira search "project = PROJ AND resolution = Unresolved" 50
atlasmd jira attachments PROJ-123                   # attachments to .jira/out/PROJ-123/, .docx → also .md (.docx images as files next to it)

atlasmd wiki page 123456                            # wiki page → Markdown + comments (inline ones with the selected text)
atlasmd wiki page "https://wiki.example.com/spaces/SPACE/pages/123456/..." --attachments   # page images are always downloaded, --attachments adds the rest
atlasmd wiki search "release notes" 30 --space SPACE   # wiki page search: text or ready CQL

atlasmd docx "<path>.docx"                          # local .docx → .md next to it (e.g. specs from attachment archives)
```

`wiki page` accepts a pageId, `viewpage.action?pageId=…`, `/spaces/X/pages/<id>/…` or `/display/SPACE/Title`.
The result goes to stdout and to `.jira/out/wiki/<pageId>/`.

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

Snapshot — `.jira/out/track/state.json`, reports — `.jira/out/track/reports/<date_time>.md`.
Dynamic parts of the Jira macro in wiki pages (issue title/status) are ignored when comparing.

### Limitations

- What was deleted **before** tracking started cannot be recovered: Confluence deletes/merges page versions itself
  (version numbers may be missing in page history), and Jira does not keep deleted comments.
- The old text of an edited Jira comment is available only if the comment was already in the snapshot (Jira keeps
  only the edit date); with `--since` and no snapshot you see what changed and when, and the current text.
- A deleted Jira comment is visible only between `track` runs (not via `--since`).
- The API does not tell who viewed an issue or page.
- `track` does not run on its own — call it whenever you sync.

## Security

- On 401, a redirect to SSO/login, or CAPTCHA the client stops at once, without retries (self-hosted Jira locks
  REST behind CAPTCHA after repeated 401s).
- Tokens are never logged. If a token leaks, revoke it in the Jira/Confluence profile → Personal Access Tokens
  (Server/DC) or at id.atlassian.com → Security → API tokens (Cloud; one token opens both services).

## Development

```
npm install                  # also builds dist/ (prepare); linked projects see changes after npm run build
npm run dev -- issue X-1     # run from src/*.ts without building (Node's native type stripping)
npm run typecheck
npm run build                # dist/ — what bin/atlasmd.js runs
```

Versions are git tags `vX.Y.Z`, and `version` in package.json must match them (it is what `atlasmd version` and
`probe` print). Release: `npm version minor` (or `patch` / `major` — bumps the version, commits and tags) →
`git push --follow-tags`. In projects: `"atlasmd": "git+https://…/atlasmd.git#semver:^1.0.0"`; to update —
`npm update atlasmd`, `npx --no atlasmd skill`, commit package-lock.json and the skill. Breaking changes (commands,
`.jira/.env` format) only in a new major version.

## License

[MIT](LICENSE)
