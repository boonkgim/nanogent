#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const docker = args.includes('--docker');
const here = dirname(fileURLToPath(import.meta.url));
const tplDir = join(here, '..', 'template');

const usage = `
nanogent — per-project chat agent with pluggable tools, reachable via Telegram

  nanogent init             drop nanogent.mjs + default tool + prompt + .env.example
  nanogent init --docker    also drop Dockerfile + docker-compose.yml
  nanogent start            run the listener (node)
  nanogent start --docker   run the listener in a docker container

after init:
  1. cp .env.example .env
  2. fill TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS, ANTHROPIC_API_KEY
  3. edit .nanogent-prompt.md for this project / client
  4. nanogent start            (or: node nanogent.mjs)
     nanogent start --docker   (or: docker compose up -d --build)

in-chat (once running):
  any text    → routed through the chat agent, which may delegate to tools
  /status     current background job
  /cancel     cancel running job
  /clear      wipe chat history
  /help       show command list

to stop:  Ctrl+C   (or: kill <pid> / pm2 stop / docker compose down)
to remove: rm -rf nanogent.mjs .nanogent .nanogent-prompt.md .env [Dockerfile docker-compose.yml]
`;

/**
 * Manifest: template source path → destination path (relative to cwd).
 * Some destinations rename (e.g. template/nanogent-prompt.md → .nanogent-prompt.md).
 */
const BASE_MANIFEST = [
  { src: 'nanogent.mjs',       dest: 'nanogent.mjs' },
  { src: '.env.example',       dest: '.env.example' },
  { src: 'nanogent-prompt.md', dest: '.nanogent-prompt.md' },
  { src: 'tools/claude.mjs',   dest: '.nanogent/tools/claude.mjs' },
];

const DOCKER_MANIFEST = [
  { src: 'Dockerfile',         dest: 'Dockerfile' },
  { src: 'docker-compose.yml', dest: 'docker-compose.yml' },
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

if (cmd === 'init') {
  const manifest = docker ? [...BASE_MANIFEST, ...DOCKER_MANIFEST] : BASE_MANIFEST;
  copyFromManifest(manifest);
  const next = docker
    ? '\nnext: cp .env.example .env && nanogent start --docker'
    : '\nnext: cp .env.example .env && nanogent start';
  console.log(next);
} else if (cmd === 'start') {
  if (docker) {
    if (!existsSync(join(process.cwd(), 'docker-compose.yml'))) {
      console.error('docker-compose.yml not found in cwd — run `nanogent init --docker` first');
      process.exit(1);
    }
    spawn('docker', ['compose', 'up', '--build'], { stdio: 'inherit' })
      .on('exit', c => process.exit(c ?? 0));
  } else {
    const script = join(process.cwd(), 'nanogent.mjs');
    if (!existsSync(script)) {
      console.error('nanogent.mjs not found in cwd — run `nanogent init` first');
      process.exit(1);
    }
    spawn(process.execPath, [script], { stdio: 'inherit' })
      .on('exit', c => process.exit(c ?? 0));
  }
} else {
  console.log(usage);
  if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(1);
}
