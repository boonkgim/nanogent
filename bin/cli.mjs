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
nanogent — per-project chat agent with pluggable tools, reachable via Telegram

  nanogent init           drop everything into .nanogent/ (node + docker files, plus prompt, config, tools)
  nanogent start          run the listener — reads .nanogent/config.json to choose node or docker mode
  nanogent start --docker force docker mode (ignores config.json)
  nanogent start --node   force node mode (ignores config.json)
  nanogent uninstall      delete .nanogent/ after confirmation
  nanogent uninstall -f   delete .nanogent/ without confirmation

after init:
  1. cp .nanogent/.env.example .nanogent/.env
  2. fill TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS, ANTHROPIC_API_KEY
  3. edit .nanogent/prompt.md for this project / client
  4. optionally flip "docker": true in .nanogent/config.json
  5. nanogent start

in-chat (once running):
  any text    → routed through the chat agent, which may delegate to tools
  /status     current background job
  /cancel     cancel running job
  /clear      wipe chat history
  /help       show command list

to stop:  Ctrl+C   (or: kill <pid> / pm2 stop / docker compose down)
to remove: nanogent uninstall   (or: rm -rf .nanogent)
`;

/**
 * Manifest: template source → destination (relative to cwd).
 * Rename semantics are baked in — template filenames are flat, installed
 * filenames are scoped under .nanogent/.
 */
const MANIFEST = [
  { src: 'nanogent.mjs',       dest: '.nanogent/nanogent.mjs' },
  { src: 'prompt.md',          dest: '.nanogent/prompt.md' },
  { src: 'config.json',        dest: '.nanogent/config.json' },
  { src: '.env.example',       dest: '.nanogent/.env.example' },
  { src: 'gitignore',          dest: '.nanogent/.gitignore' },   // npm strips .gitignore from packages, so ship it as `gitignore` and rename on install
  { src: 'Dockerfile',         dest: '.nanogent/Dockerfile' },
  { src: 'docker-compose.yml', dest: '.nanogent/docker-compose.yml' },
  { src: 'tools/claude/index.mjs', dest: '.nanogent/tools/claude/index.mjs' },
  { src: 'tools/claude/README.md', dest: '.nanogent/tools/claude/README.md' },
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
    '  $EDITOR .nanogent/.env          # fill in tokens and ANTHROPIC_API_KEY',
    '  $EDITOR .nanogent/prompt.md     # tailor the prompt for this project / client',
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
