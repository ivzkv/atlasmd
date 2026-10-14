// Where settings come from and where results go — the current folder the CLI is run from (the project root),
// not where the package is installed (otherwise out/ would end up in node_modules). Parent folders are not searched:
// running outside the root is an error with the exact path, not a .env "found" somewhere above.
//
//   ./.jira/.env   — URLs and tokens (JIRA_ENV_FILE — an explicit other path)
//   ./.jira/out/   — issues, wiki pages, attachments, track state (JIRA_OUT_DIR — an explicit other path)
//   ./.jira/version — the tool version the project is pinned to; the only file of .jira/ that goes to git

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RUN } from './package.ts';

export const CONFIG_DIR = resolve('.jira');
export const VERSION_FILE = join(CONFIG_DIR, 'version');

export const ENV_FILE = resolve(process.env.JIRA_ENV_FILE?.trim() || join(CONFIG_DIR, '.env'));
export const ENV_FOUND = existsSync(ENV_FILE);

// Variables from ENV_FILE; ones already set in the environment are not overwritten. Done at module import,
// so JIRA_OUT_DIR can be set in the .env itself.
if (ENV_FOUND) process.loadEnvFile(ENV_FILE);

export const OUT_DIR = resolve(process.env.JIRA_OUT_DIR?.trim() || join(CONFIG_DIR, 'out'));

/** Hint for configuration errors: where the .env was looked for and what to do if it is missing. */
export const envHint = () =>
  ENV_FOUND
    ? `fill in ${ENV_FILE}`
    : `${ENV_FILE} does not exist — run from the project root (where .jira/ is) or create it: ${RUN} init`;
