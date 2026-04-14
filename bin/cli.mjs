#!/usr/bin/env node
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readSync, rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const here = dirname(fileURLToPath(import.meta.url));
const tplDir = join(here, '..', 'template');

const usage = `
nanogent — per-project chat agent with pluggable tools, channels, and providers

  nanogent init             drop everything into .nanogent/ (runtime, prompt, config, contacts, tool, channel, provider)
  nanogent start            run the listener — reads .nanogent/config.json to choose node or docker mode
  nanogent start --docker   force docker mode (ignores config.json)
  nanogent start --node     force node mode (ignores config.json)
  nanogent update           update runtime code; preserves prompt / config / contacts / local plugin edits
  nanogent update --force   also overwrite locally-modified plugin files
  nanogent update --dry-run show what update would do, without changing files
  nanogent uninstall        delete .nanogent/ after confirmation
  nanogent uninstall -f     delete .nanogent/ without confirmation

after init:
  1. cp .nanogent/.env.example .nanogent/.env
  2. fill TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY in .env
  3. edit .nanogent/contacts.json — replace the REPLACE_WITH_YOUR_TELEGRAM_* placeholders
  4. edit .nanogent/prompt.md for this project / client
  5. optionally flip "docker": true in .nanogent/config.json
  6. nanogent start

in-chat (once running):
  any text    → routed through the chat agent, which may delegate to tools
  /status     current background job
  /cancel     cancel running job
  /clear      wipe chat history for the current chat
  /help       show command list

to stop:    Ctrl+C   (or: kill <pid> / pm2 stop / docker compose down)
to update:  nanogent update
to remove:  nanogent uninstall   (or: rm -rf .nanogent)
`;

/**
 * Manifest. Every template file maps to a destination, tagged with a type
 * that determines how `nanogent update` handles it:
 *
 *   code   — always overwritten on update. No one should be customising these.
 *   plugin — overwritten only if the file is byte-identical to what we ship
 *            (no local modifications). Lets bug fixes reach users while
 *            preserving any customisations operators have made.
 *   config — never touched by update; only created if missing. Operator-owned.
 */
const MANIFEST = [
  // Core runtime (always updatable)
  { src: 'nanogent.mjs',       dest: '.nanogent/nanogent.mjs',       type: 'code' },
  { src: 'Dockerfile',         dest: '.nanogent/Dockerfile',         type: 'code' },
  { src: 'docker-compose.yml', dest: '.nanogent/docker-compose.yml', type: 'code' },
  { src: '.env.example',       dest: '.nanogent/.env.example',       type: 'code' },

  // User config (never touched by update; only created on init)
  { src: 'prompt.md',          dest: '.nanogent/prompt.md',          type: 'config' },
  { src: 'config.json',        dest: '.nanogent/config.json',        type: 'config' },
  { src: 'contacts.json',      dest: '.nanogent/contacts.json',      type: 'config' },
  { src: 'gitignore',          dest: '.nanogent/.gitignore',         type: 'config' },  // npm strips .gitignore — ship as `gitignore`, rename on install

  // Default tool (customisable, but update if unmodified)
  { src: 'tools/claude/index.mjs', dest: '.nanogent/tools/claude/index.mjs', type: 'plugin' },
  { src: 'tools/claude/README.md', dest: '.nanogent/tools/claude/README.md', type: 'plugin' },
  { src: 'tools/claude/gitignore', dest: '.nanogent/tools/claude/.gitignore', type: 'plugin' },  // same npm workaround

  // Default channel
  { src: 'channels/telegram/index.mjs', dest: '.nanogent/channels/telegram/index.mjs', type: 'plugin' },
  { src: 'channels/telegram/README.md', dest: '.nanogent/channels/telegram/README.md', type: 'plugin' },

  // Default provider
  { src: 'providers/anthropic/index.mjs', dest: '.nanogent/providers/anthropic/index.mjs', type: 'plugin' },
  { src: 'providers/anthropic/README.md', dest: '.nanogent/providers/anthropic/README.md', type: 'plugin' },
];

function copyFromManifest(manifest) {
  for (const { src, dest } of manifest) {
    const from = join(tplDir, src);
    const to = join(process.cwd(), dest);
    if (existsSync(to)) {
      console.log(`skip (exists): ${dest}`);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(`created:       ${dest}`);
  }
}

/**
 * Iterate the manifest with type-aware update semantics.
 *
 *   code:   always overwrite
 *   plugin: overwrite only if unmodified locally (byte-identical); otherwise
 *           skip and surface a diff hint — pass --force to override
 *   config: never overwrite; only create if missing
 *
 * Returns a summary object for the final report.
 */
function runUpdate({ force, dryRun }) {
  const counts = { updated: 0, created: 0, preserved: 0, skipped: 0, identical: 0 };
  const skippedPaths = [];

  for (const { src, dest, type } of MANIFEST) {
    const from = join(tplDir, src);
    const to   = join(process.cwd(), dest);
    const missing = !existsSync(to);

    // Missing files are created regardless of type — new version introduced a
    // new file, operator wants it.
    if (missing) {
      if (!dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      console.log(`created:    ${dest}`);
      counts.created++;
      continue;
    }

    if (type === 'config') {
      console.log(`preserved:  ${dest} (user config)`);
      counts.preserved++;
      continue;
    }

    if (type === 'code') {
      if (!dryRun) copyFileSync(from, to);
      console.log(`updated:    ${dest}`);
      counts.updated++;
      continue;
    }

    if (type === 'plugin') {
      const current = readFileSync(to);
      const shipped = readFileSync(from);
      if (current.equals(shipped)) {
        console.log(`unchanged:  ${dest}`);
        counts.identical++;
        continue;
      }
      if (force) {
        if (!dryRun) copyFileSync(from, to);
        console.log(`updated:    ${dest} (forced overwrite of local changes)`);
        counts.updated++;
      } else {
        console.log(`skipped:    ${dest} (locally modified — pass --force to overwrite)`);
        skippedPaths.push(dest);
        counts.skipped++;
      }
      continue;
    }

    console.log(`? unknown type '${type}' for ${dest} (skipping)`);
  }

  console.log('');
  console.log(
    `Summary: ${counts.updated} updated, ${counts.created} created, ` +
    `${counts.identical} already up-to-date, ${counts.preserved} preserved, ${counts.skipped} skipped`,
  );

  if (skippedPaths.length > 0) {
    console.log('');
    console.log('Skipped files had local modifications. To compare one against the shipped version:');
    for (const p of skippedPaths) {
      const src = MANIFEST.find(m => m.dest === p)?.src;
      if (src) console.log(`  diff ${p} ${join(tplDir, src)}`);
    }
    console.log('');
    console.log('To overwrite all locally-modified plugin files, re-run with --force.');
  }

  if (dryRun) {
    console.log('');
    console.log('(dry run — no files were actually changed)');
  }

  return counts;
}

/** Read .nanogent/config.json if present, return empty object otherwise. */
function readConfig() {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), '.nanogent', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Simple blocking stdin prompt, no dependencies. */
function confirm(prompt) {
  process.stdout.write(prompt);
  const buf = Buffer.alloc(32);
  let n = 0;
  try { n = readSync(0, buf, 0, buf.length, null); } catch { return false; }
  const ans = buf.toString('utf8', 0, n).trim().toLowerCase();
  return ans === 'y' || ans === 'yes';
}

if (cmd === 'init') {
  copyFromManifest(MANIFEST);
  console.log([
    '',
    'next:',
    '  cp .nanogent/.env.example .nanogent/.env',
    '  $EDITOR .nanogent/.env           # fill in TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY',
    '  $EDITOR .nanogent/contacts.json  # add yourself as an operator with your Telegram chatId',
    '  $EDITOR .nanogent/prompt.md      # tailor the system prompt for this project / client',
    '  nanogent start',
  ].join('\n'));
} else if (cmd === 'start') {
  // Mode selection: explicit flag > config.json > node default
  const explicitDocker = args.includes('--docker');
  const explicitNode   = args.includes('--node');
  let useDocker;
  if (explicitDocker) useDocker = true;
  else if (explicitNode) useDocker = false;
  else useDocker = !!readConfig().docker;

  if (useDocker) {
    const composePath = join(process.cwd(), '.nanogent', 'docker-compose.yml');
    if (!existsSync(composePath)) {
      console.error('.nanogent/docker-compose.yml not found — run `nanogent init` first');
      process.exit(1);
    }
    spawn('docker', ['compose', '-f', composePath, 'up', '--build'], { stdio: 'inherit' })
      .on('exit', c => process.exit(c ?? 0));
  } else {
    const script = join(process.cwd(), '.nanogent', 'nanogent.mjs');
    if (!existsSync(script)) {
      console.error('.nanogent/nanogent.mjs not found — run `nanogent init` first');
      process.exit(1);
    }
    spawn(process.execPath, [script], { stdio: 'inherit' })
      .on('exit', c => process.exit(c ?? 0));
  }
} else if (cmd === 'update') {
  if (!existsSync(join(process.cwd(), '.nanogent'))) {
    console.error('.nanogent/ not found — run `nanogent init` first');
    process.exit(1);
  }
  const force  = args.includes('--force') || args.includes('-f');
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  runUpdate({ force, dryRun });
} else if (cmd === 'uninstall') {
  const target = join(process.cwd(), '.nanogent');
  if (!existsSync(target)) {
    console.log('.nanogent/ not found — nothing to uninstall');
    process.exit(0);
  }
  const force = args.includes('--force') || args.includes('-f');
  if (!force) {
    const ok = confirm(
      'This will permanently delete .nanogent/\n' +
      '(including your prompt, config, tools, chat history, and learnings).\n' +
      'Proceed? [y/N]: ',
    );
    if (!ok) {
      console.log('aborted');
      process.exit(0);
    }
  }
  rmSync(target, { recursive: true, force: true });
  console.log('removed: .nanogent/');
} else {
  console.log(usage);
  if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(1);
}
