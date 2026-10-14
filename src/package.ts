// The tool's own package.json: its version and the command that runs exactly this version.
// Projects do not install atlasmd: the skill tells Claude to run `npx -y github:<repo>#v<version>` with the version from
// the project's .jira/version, and npx fetches (and caches) that tag from GitHub on first use.

import { readFileSync } from 'node:fs';

// package.json is one level up from both src/ (development) and dist/ (fetched package)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION: string = pkg.version;

/** Command that runs this version from GitHub; `-y` is safe here — the source is an explicit repo and tag, not a registry name. */
export const RUN = `npx -y ${pkg.repository}#v${VERSION}`;
