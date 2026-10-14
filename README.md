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
- **Files the agent can come back to.** Everything is saved under predictable paths (`.jira/out/<KEY>/<KEY>.md`),
  so the agent re-reads a file instead of repeating the request.
- **Images and attachments, locally.** Images are downloaded and linked relatively, so a multimodal agent can see
  them; `.docx` attachments are converted to `.md`.
- **Secrets stay out of the context.** Tokens are never printed; the bundled skill and a deny rule keep the agent
  away from `.jira/.env`.
- **Fails fast, never retries.** On 401, CAPTCHA or an SSO redirect it stops at once — an agent in a loop cannot
  lock the account with repeated attempts.
- **Errors tell the next step.** Errors include the exact path and the command to run
  (`… or create it: npx --no atlasmd init`), so the agent can fix things on its own.
- **"What changed?" built in.** `track` reports what changed in issues and their linked wiki pages since the last
  run or a date — a ready answer to one of the most common questions.
- **Ships its own Claude Code skill.** The agent instructions come with the package, match its version, install with
  one command, and `probe` tells you when they are outdated.

## What it looks like

```
> what is in PROJ-123 and what changed since yesterday?

$ npx --no atlasmd jira issue PROJ-123
$ npx --no atlasmd track PROJ-123 --since 2026-10-13
→ the agent reads .jira/out/PROJ-123/PROJ-123.md and the track report, and answers
```

## Quick start

Requires Node ≥ 23.8. Run from the root of your project:

```
npm i -D "git+https://github.com/ivzkv/atlasmd.git#semver:^1.0.0"   # 1. install (built on install)
npx --no atlasmd init                                                # 2. create .jira/.env, .jira/.gitignore and the skill
                                                                     # 3. fill in your URLs and token in .jira/.env
npx --no atlasmd probe                                               # 4. check access
```

Everyone working on the project gets the tool with `npm install`; each person runs `init` once and fills in their own
token. Always run it as `npx --no atlasmd …` — without `--no`, if the package is not installed, npx downloads
whatever public npm package has that name.

Settings and results live in the project, not in the package, and the whole `.jira/` folder stays out of git
through its own `.gitignore` (the project's `.gitignore` needs no changes):

```
<project root>/.jira/.env    URLs and tokens          (other path — JIRA_ENV_FILE)
<project root>/.jira/out/    issues, wiki, track      (other path — JIRA_OUT_DIR)
```

The tool reads `.jira/` only in the current folder and does not search parent folders — run it from the project
root (from another folder you get an error with the exact path). `probe` prints which files are used.

## Using with Claude Code

- `npx --no atlasmd skill` (also run by `init`) puts `.claude/skills/atlasmd/SKILL.md` from the installed package
  version into the project. It tells Claude when and how to use the tool, how to handle failures, and what never
  to touch. After `npm update atlasmd`, run it again and commit the diff; `probe` shows whether the skill is up to date.
- Deny Claude access to the tokens in the project's `.claude/settings.json`:
  `"permissions": { "deny": ["Read(/.jira/.env*)", "Edit(/.jira/.env*)"] }`. `skill` reminds you if the rule is missing.

Other agents can use the same commands — any agent that can run a shell command and read a file works.

## Commands

```
atlasmd jira issue PROJ-123                         # issue: fields, description, comments, links (incl. wiki) → stdout and .jira/out/PROJ-123/PROJ-123.md;
                                                    #   issue images are downloaded and shown in the .md (in place in the description/comments)
atlasmd jira issue PROJ-123 --attachments           # the same + all attachments next to it, linked from the .md (.docx → also .md)
atlasmd jira search "project = PROJ AND resolution = Unresolved" 50
atlasmd jira attachments PROJ-123                   # attachments to .jira/out/PROJ-123/, .docx → also .md (.docx images as files next to it)

atlasmd wiki page 123456                            # wiki page → Markdown + comments (inline ones with the selected text)
atlasmd wiki page "https://wiki.example.com/spaces/SPACE/pages/123456/..." --attachments   # page images are always downloaded, --attachments adds the rest
atlasmd wiki search "release notes" 30 --space SPACE   # wiki page search: text or ready CQL

atlasmd probe                                       # version, user, permissions, projects, boards, fields, attachments, Confluence
atlasmd docx "<path>.docx"                          # local .docx → .md next to it (e.g. specs from attachment archives)
atlasmd init                                        # set up the project: .jira/.env, .jira/.gitignore, Claude Code skill
atlasmd skill                                       # install / update .claude/skills/atlasmd/SKILL.md from this version
atlasmd version                                     # tool version (also in the first line of probe); not --version: npx intercepts it
```

`atlasmd jira` or `atlasmd wiki` without a subcommand prints that group's commands. `wiki page` accepts a pageId,
`viewpage.action?pageId=…`, `/spaces/X/pages/<id>/…` or `/display/SPACE/Title`; the result goes to stdout and to
`.jira/out/wiki/<pageId>/`.

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

## Configuration

`.jira/.env` (created by `npx --no atlasmd init` from [env.example](env.example)) — one of the options; Jira and
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
npm run build                  # dist/ — what bin/atlasmd.js runs
```

To try local changes in a project, link the working copy (nothing is written to the project's package.json):

```
cd atlasmd && npm link                      # once
cd <project> && npm link atlasmd            # repeat after every npm install / npm ci in the project
```

Linked projects see changes after `npm run build`. Dependencies are only Markdown converters: `turndown` (+ gfm for
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
fail. In projects: `"atlasmd": "git+https://github.com/ivzkv/atlasmd.git#semver:^1.0.0"`; to update —
`npm update atlasmd`, `npx --no atlasmd skill`, commit package-lock.json and the skill. Breaking changes (commands,
`.jira/.env` format) only in a new major version.

## License

[MIT](LICENSE)
