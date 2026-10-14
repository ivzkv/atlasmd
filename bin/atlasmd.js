#!/usr/bin/env node
// Package entry point. Re-runs Node with --use-system-ca so HTTPS trusts certificates from the OS store
// (corporate root CAs on self-hosted Jira/Confluence), and passes the exit code through.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// npm only warns about engines, and an old Node fails on --use-system-ca with an obscure error — so check here.
// The minimum comes from engines.node in package.json (format ">=X.Y") so it is not duplicated.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [minMajor, minMinor] = (pkg.engines?.node.match(/(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
const [major, minor] = process.versions.node.split('.').map(Number);
if (minMajor !== undefined && (major < minMajor || (major === minMajor && minor < minMinor))) {
  console.error(`⛔ atlasmd needs Node ${pkg.engines.node}, but this is ${process.versions.node}. Update Node.`);
  process.exit(1);
}

// A source checkout (the copy a project fetches into .atlasmd/tool, or the repo itself) runs src/*.ts directly through
// Node's native type stripping, no build needed; a built package ships only dist/.
const src = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const dist = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const entry = existsSync(src) ? src : dist;
if (!existsSync(entry)) {
  console.error('⛔ neither src/cli.ts nor dist/cli.js found — fetch the tool again or build it: npm run build');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--use-system-ca', entry, ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.error) {
  console.error(`⛔ ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
