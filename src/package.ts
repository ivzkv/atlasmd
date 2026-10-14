// The tool's own package.json: its version, and how a project gets and runs a version.
// Projects do not install atlasmd: they pin a version in .atlasmd/version (committed) and keep the source of that tag in
// .atlasmd/tool/ (out of git), fetched with git + npm; the skill runs it as `node .atlasmd/tool/bin/atlasmd.js`.

import { readFileSync } from 'node:fs';

// package.json is one level up from both src/ (source checkout) and dist/ (built package)
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION: string = pkg.version;

/** Command that runs the project's copy of the tool (from the project root). */
export const RUN = 'node .atlasmd/tool/bin/atlasmd.js';

const REPO_URL = `https://github.com/${String(pkg.repository).replace(/^github:/, '')}.git`;

/** Commands that put the source of tag v<version> into .atlasmd/tool (the folder must not exist) with runtime dependencies only. */
export const fetchCommands = (version: string) =>
  `git -c advice.detachedHead=false clone -q --depth 1 --branch v${version} ${REPO_URL} .atlasmd/tool && ` +
  'npm ci --omit=dev --ignore-scripts --prefix .atlasmd/tool';
