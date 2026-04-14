// nanogent.mjs — per-project Telegram → Claude Code bridge.
// Zero dependencies. The chat agent never blocks: new messages (and /status,
// /cancel, /queue) are always processed even while a Claude Code job is running.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';

const env = loadEnv('.env');
const TOKEN = env.TELEGRAM_BOT_TOKEN;
const ALLOWED = new Set(
  (env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
);
if (!TOKEN) {
  console.error('[nanogent] missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const STATE = '.nanogent.json';
const MAX = 3900;      // Telegram hard cap is 4096 chars; leave headroom.
const EDIT_MS = 1200;  // Telegram rate-limits edits; ~1.2s is safe.

const tg = (method, payload) =>
  fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(r => r.json())
    .catch(() => ({}));

const state = {
  currentJob: null,  // { prompt, chatId, msgId, child, startedAt, cancelled }
  queue: [],         // [{ prompt, chatId }]
};

let offset = 0;
console.log(`[nanogent] listening in ${process.cwd()}`);
process.on('SIGINT', () => { console.log('\n[nanogent] bye'); process.exit(0); });

while (true) {
  const { result = [] } = await tg('getUpdates', { offset, timeout: 30 });
  for (const u of result) {
    offset = u.update_id + 1;
    const m = u.message;
    if (!m?.text) continue;
    const chatId = String(m.chat.id);
    if (ALLOWED.size && !ALLOWED.has(chatId)) continue;
    await handle(m.text.trim(), chatId);
  }
}

async function handle(text, chatId) {
  if (text === '/status')   return showStatus(chatId);
  if (text === '/cancel')   return cancelJob(chatId);
  if (text === '/queue')    return showQueue(chatId);
  if (text === '/help' || text === '/start') {
    return tg('sendMessage', { chat_id: chatId, text: 'send any text to run in this project.\ncommands: /status /cancel /queue' });
  }
  if (text.startsWith('/')) {
    return tg('sendMessage', { chat_id: chatId, text: 'unknown command. try /status /cancel /queue' });
  }

  if (state.currentJob) {
    state.queue.push({ prompt: text, chatId });
    await tg('sendMessage', { chat_id: chatId, text: `⏳ queued (position ${state.queue.length})` });
    return;
  }
  startJob(text, chatId);
}

function startJob(prompt, chatId) {
  // Set currentJob synchronously so the next incoming message sees "busy".
  state.currentJob = { prompt, chatId, msgId: null, child: null, startedAt: Date.now(), cancelled: false };
  run(prompt, chatId).catch(e => console.error('[nanogent] run error:', e)).finally(() => {
    state.currentJob = null;
    const next = state.queue.shift();
    if (next) startJob(next.prompt, next.chatId);
  });
}

function showStatus(chatId) {
  const j = state.currentJob;
  if (!j) return tg('sendMessage', { chat_id: chatId, text: '💤 idle' });
  const secs = Math.round((Date.now() - j.startedAt) / 1000);
  const q = state.queue.length;
  return tg('sendMessage', {
    chat_id: chatId,
    text: `🏃 running ${secs}s\nprompt: ${j.prompt.slice(0, 200)}${q ? `\nqueued: ${q}` : ''}`,
  });
}

function showQueue(chatId) {
  if (!state.currentJob && state.queue.length === 0) {
    return tg('sendMessage', { chat_id: chatId, text: '💤 nothing running, nothing queued' });
  }
  const cur = state.currentJob ? `▶ ${state.currentJob.prompt.slice(0, 80)}` : '(idle)';
  const q = state.queue.map((j, i) => `${i + 1}. ${j.prompt.slice(0, 80)}`).join('\n');
  return tg('sendMessage', { chat_id: chatId, text: `${cur}${q ? '\n' + q : ''}` });
}

function cancelJob(chatId) {
  const j = state.currentJob;
  if (!j) return tg('sendMessage', { chat_id: chatId, text: 'nothing to cancel' });
  j.cancelled = true;
  if (j.child) {
    j.child.kill('SIGTERM');
    return tg('sendMessage', { chat_id: chatId, text: '🛑 cancelling…' });
  }
  return tg('sendMessage', { chat_id: chatId, text: '🛑 cancel requested (job still starting)' });
}

async function run(prompt, chatId) {
  const first = await tg('sendMessage', { chat_id: chatId, text: '🤔 thinking…' });
  const msgId = first?.result?.message_id;
  if (state.currentJob) state.currentJob.msgId = msgId;

  // Honor a /cancel that arrived before we got here.
  if (state.currentJob?.cancelled) {
    if (msgId) await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: '🛑 cancelled before start' });
    return;
  }

  const hasSession = existsSync(STATE);
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    ...(hasSession ? ['--continue'] : []),
  ];
  const child = spawn('claude', args, { cwd: process.cwd(), env: process.env });
  if (state.currentJob) state.currentJob.child = child;

  let buffer = '';
  let acc = '';           // streamed assistant text + tool-use markers
  let finalResult = '';   // filled from the `result` event (authoritative)
  let lastEdit = 0;
  let pending = null;

  const render = () => (finalResult || acc || '…').slice(-MAX);

  const flush = () => {
    if (!msgId) return;
    const now = Date.now();
    const wait = EDIT_MS - (now - lastEdit);
    if (wait > 0) {
      clearTimeout(pending);
      pending = setTimeout(flush, wait);
      return;
    }
    lastEdit = now;
    tg('editMessageText', { chat_id: chatId, message_id: msgId, text: render() });
  };

  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const ev = JSON.parse(trimmed);
        if (ev.type === 'assistant' && ev.message?.content) {
          for (const b of ev.message.content) {
            if (b.type === 'text') acc += b.text;
            else if (b.type === 'tool_use') acc += `\n🔧 ${b.name}(${Object.keys(b.input || {}).join(', ')})\n`;
          }
        } else if (ev.type === 'result') {
          finalResult = ev.result || acc;
        }
      } catch {
        // not a JSON line — ignore
      }
    }
    flush();
  });

  child.stderr.on('data', d => process.stderr.write(d));

  await new Promise(resolve => child.on('close', resolve));
  clearTimeout(pending);
  if (!hasSession) writeFileSync(STATE, JSON.stringify({ started: new Date().toISOString() }));

  const cancelled = state.currentJob?.cancelled;
  const body = (finalResult || acc).trim();
  const full = cancelled
    ? `🛑 cancelled\n${body || '(no output before cancel)'}`
    : (body || '(no output)');

  if (msgId) {
    await tg('editMessageText', { chat_id: chatId, message_id: msgId, text: full.slice(-MAX) });
  }
  if (full.length > MAX) {
    await tg('sendMessage', { chat_id: chatId, text: '— head of output —\n' + full.slice(0, MAX) });
  }
}

function loadEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i < 0) continue;
    out[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
