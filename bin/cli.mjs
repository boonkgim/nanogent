#!/usr/bin/env node
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const docker = args.includes('--docker');
const here = dirname(fileURLToPath(import.meta.url));
const tplDir = join(here, '..', 'template');

const usage = `
nanogent — per-project Telegram ↔ Claude Code bridge

  nanogent init             copy nanogent.mjs + .env.example into the current folder
  nanogent init --docker    also copy Dockerfile + docker-compose.yml
  nanogent start            run the listener in the current folder (node)
  nanogent start --docker   run the listener in a docker container

after init:
  1. cp .env.example .env
  2. fill TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_ALLOWED_CHAT_IDS
  3. nanogent start            (or: node nanogent.mjs)
     nanogent start --docker   (or: docker compose up -d)

in-chat commands (once running):
  /status   show the running job and queue depth
  /cancel   SIGTERM the running job
  /queue    list running + queued prompts

to stop:  Ctrl+C   (or: kill <pid> / pm2 stop / docker compose down)
to remove: rm nanogent.mjs .nanogent.json .env [Dockerfile docker-compose.yml]
`;

const baseFiles = ['nanogent.mjs', '.env.example'];
const dockerFiles = ['Dockerfile', 'docker-compose.yml'];

if (cmd === 'init') {
  const files = docker ? [...baseFiles, ...dockerFiles] : baseFiles;
  for (const f of files) {
    const dest = join(process.cwd(), f);
    if (existsSync(dest)) {
      console.log(`skip (exists): ${f}`);
      continue;
    }
    copyFileSync(join(tplDir, f), dest);
    console.log(`created:       ${f}`);
  }
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
