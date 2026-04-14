#!/usr/bin/env node
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const [, , cmd = 'help'] = process.argv;
const here = dirname(fileURLToPath(import.meta.url));
const tplDir = join(here, '..', 'template');

const usage = `
nanogent — per-project Telegram ↔ Claude Code bridge

  nanogent init    copy nanogent.mjs + .env.example into the current folder
  nanogent start   run the listener in the current folder

after init:
  1. cp .env.example .env
  2. fill TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_ALLOWED_CHAT_IDS
  3. nanogent start   (or: node nanogent.mjs)

in-chat commands (once running):
  /status   show the running job and queue depth
  /cancel   SIGTERM the running job
  /queue    list running + queued prompts

to stop:  Ctrl+C   (or kill the pid / pm2 stop)
to remove: rm nanogent.mjs .nanogent.json .env
`;

if (cmd === 'init') {
  for (const f of ['nanogent.mjs', '.env.example']) {
    const dest = join(process.cwd(), f);
    if (existsSync(dest)) {
      console.log(`skip (exists): ${f}`);
      continue;
    }
    copyFileSync(join(tplDir, f), dest);
    console.log(`created:       ${f}`);
  }
  console.log('\nnext: cp .env.example .env && nanogent start');
} else if (cmd === 'start') {
  const script = join(process.cwd(), 'nanogent.mjs');
  if (!existsSync(script)) {
    console.error('nanogent.mjs not found in cwd — run `nanogent init` first');
    process.exit(1);
  }
  spawn(process.execPath, [script], { stdio: 'inherit' })
    .on('exit', c => process.exit(c ?? 0));
} else {
  console.log(usage);
  if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(1);
}
