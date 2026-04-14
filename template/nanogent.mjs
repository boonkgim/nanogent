// nanogent.mjs — per-project chat agent with pluggable tools, reachable via Telegram.
// Zero dependencies. Chat agent drives the conversation; tools live in .nanogent/tools/.
// Long-running tools are non-blocking: they return a jobId and the chat agent keeps
// talking to the user while the job runs. When the job finishes, a synthetic [SYSTEM]
// message is injected and the chat agent decides what to say.

import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const env = loadEnv('.env');
const TELEGRAM_TOKEN = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED = new Set(
  (env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_ALLOWED_CHAT_IDS || '')
    .split(',').map(s => s.trim()).filter(Boolean),
);
const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
const CHAT_MODEL = env.NANOGENT_CHAT_MODEL || process.env.NANOGENT_CHAT_MODEL || 'claude-haiku-4-5';
const MAX_HISTORY = Number(env.NANOGENT_MAX_HISTORY || process.env.NANOGENT_MAX_HISTORY || 80);
const MAX_TOKENS = Number(env.NANOGENT_MAX_TOKENS || process.env.NANOGENT_MAX_TOKENS || 1024);

if (!TELEGRAM_TOKEN) die('missing TELEGRAM_BOT_TOKEN in .env');
if (!ANTHROPIC_KEY) die('missing ANTHROPIC_API_KEY in .env');

const TG_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MAX_MSG = 3900;

const STATE_DIR = '.nanogent/state';
const HISTORY_PATH = `${STATE_DIR}/history.jsonl`;
const LEARNINGS_PATH = `${STATE_DIR}/learnings.md`;
const PROMPT_PATH = '.nanogent-prompt.md';
const TOOLS_DIR = '.nanogent/tools';

mkdirSync(STATE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function tg(method, payload) {
  try {
    const r = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch (e) {
    log('tg error', method, e?.message || e);
    return {};
  }
}

const sendMessage = (chatId, text) =>
  tg('sendMessage', { chat_id: chatId, text: truncate(text) });

const editMessage = (chatId, messageId, text) =>
  tg('editMessageText', { chat_id: chatId, message_id: messageId, text: truncate(text) });

// ---------------------------------------------------------------------------
// History (persistent)
// ---------------------------------------------------------------------------

/** @type {Array<{role:'user'|'assistant',content:any}>} */
let history = loadHistory();

function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return readFileSync(HISTORY_PATH, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (e) {
    log('history load error', e?.message || e);
    return [];
  }
}

function saveHistory() {
  if (history.length > MAX_HISTORY) {
    history = history.slice(-MAX_HISTORY);
  }
  writeFileSync(HISTORY_PATH, history.map(h => JSON.stringify(h)).join('\n') + '\n');
}

function clearHistory() {
  history = [];
  try { unlinkSync(HISTORY_PATH); } catch {}
}

// ---------------------------------------------------------------------------
// Learnings (markdown-append)
// ---------------------------------------------------------------------------

function loadLearnings() {
  if (!existsSync(LEARNINGS_PATH)) return '';
  try { return readFileSync(LEARNINGS_PATH, 'utf8'); } catch { return ''; }
}

function appendLearning(title, content) {
  const date = new Date().toISOString().slice(0, 10);
  const entry = `\n## [${date}] ${title}\n${content}\n`;
  if (!existsSync(LEARNINGS_PATH)) {
    writeFileSync(LEARNINGS_PATH, `# Learnings\n${entry}`);
  } else {
    appendFileSync(LEARNINGS_PATH, entry);
  }
}

// ---------------------------------------------------------------------------
// Job registry (in-memory)
// ---------------------------------------------------------------------------

/**
 * One long-running tool job at a time per project.
 * @type {null | { jobId:string, toolName:string, title:string, startedAt:number, cancel:()=>void }}
 */
let activeJob = null;

function newJobId() {
  return randomUUID().slice(0, 8);
}

function registerJob({ jobId, toolName, title, cancel, promise }) {
  activeJob = { jobId, toolName, title, startedAt: Date.now(), cancel };
  promise.then(
    result => onJobComplete(jobId, 'completed', result),
    err    => onJobComplete(jobId, 'failed', err?.message || String(err)),
  );
}

async function onJobComplete(jobId, status, result) {
  if (!activeJob || activeJob.jobId !== jobId) return; // cancelled / superseded
  const { toolName, title, startedAt } = activeJob;
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  activeJob = null;
  // Inject synthetic system message, queue a turn so the chat agent responds.
  const body = typeof result === 'string' ? result : JSON.stringify(result);
  enqueueTurn({
    type: 'system',
    text: `[SYSTEM] Tool '${toolName}' (job ${jobId}, "${title}") ${status} after ${elapsed}s:\n${body}`,
  });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} Tool name → tool module (default export) */
const tools = new Map();

async function loadTools() {
  // Core tools (built into the runtime — not in .nanogent/tools/)
  tools.set('skip', {
    name: 'skip',
    description: 'Call this when the incoming message is NOT directed at you (side conversations, chatter meant for other humans). Do not reply with text when you skip.',
    input_schema: { type: 'object', properties: {}, required: [] },
  });
  tools.set('check_job_status', {
    name: 'check_job_status',
    description: 'Check what tool-driven background job is currently running and how long it has been going. Use when the user asks about progress.',
    input_schema: { type: 'object', properties: {}, required: [] },
  });
  tools.set('cancel_job', {
    name: 'cancel_job',
    description: 'Cancel the currently running background job. Use when the user explicitly wants to stop, change direction, or start a different task.',
    input_schema: { type: 'object', properties: {}, required: [] },
  });
  tools.set('learn', {
    name: 'learn',
    description: 'Save a persistent note about this project or its client — preferences, conventions, tech stack, tone. These are injected into your system prompt on every turn.',
    input_schema: {
      type: 'object',
      properties: {
        title:   { type: 'string', description: 'Short slug-like title (e.g. "prefers-british-english").' },
        content: { type: 'string', description: 'The fact to remember and why it matters.' },
      },
      required: ['title', 'content'],
    },
  });

  // Plugin tools from .nanogent/tools/
  if (existsSync(TOOLS_DIR)) {
    for (const file of readdirSync(TOOLS_DIR)) {
      if (!file.endsWith('.mjs') || file.startsWith('_')) continue;
      try {
        const mod = await import(pathToFileURL(resolve(TOOLS_DIR, file)).href);
        const t = mod.default;
        if (!t?.name || typeof t.execute !== 'function') {
          log(`tool ${file}: invalid shape, skipping`);
          continue;
        }
        tools.set(t.name, t);
        log(`loaded tool: ${t.name} (${file})`);
      } catch (e) {
        log(`tool ${file}: load error`, e?.message || e);
      }
    }
  }
}

function toolSchemas() {
  return [...tools.values()].map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/** Returns tool_result content (string) or { skip: true } for the 'skip' core tool. */
async function executeTool(name, input, ctx) {
  const tool = tools.get(name);
  if (!tool) return `error: unknown tool '${name}'`;

  if (name === 'skip')              return { skip: true };
  if (name === 'check_job_status')  return coreCheckJobStatus();
  if (name === 'cancel_job')        return coreCancelJob();
  if (name === 'learn')             return coreLearn(input);

  // Plugin tool
  try {
    const res = await tool.execute(input || {}, ctx);
    if (res?.async && res?.jobId) {
      return res.content || `Job ${res.jobId} started — you'll be notified on completion.`;
    }
    return res?.content ?? (typeof res === 'string' ? res : JSON.stringify(res ?? {}));
  } catch (e) {
    return `error: tool '${name}' threw: ${e?.message || String(e)}`;
  }
}

function coreCheckJobStatus() {
  if (!activeJob) return 'No job running. Idle.';
  const secs = Math.round((Date.now() - activeJob.startedAt) / 1000);
  return `Running: '${activeJob.title}' (tool=${activeJob.toolName}, id=${activeJob.jobId}, ${secs}s elapsed).`;
}

function coreCancelJob() {
  if (!activeJob) return 'No job to cancel.';
  try {
    activeJob.cancel?.();
    return `Cancel requested for '${activeJob.title}' (id=${activeJob.jobId}).`;
  } catch (e) {
    return `Cancel attempted but threw: ${e?.message || String(e)}`;
  }
}

function coreLearn({ title, content }) {
  if (!title || !content) return 'error: learn requires both title and content';
  appendLearning(title, content);
  return `Saved: "${title}"`;
}

// ---------------------------------------------------------------------------
// Chat agent turn (Anthropic API loop)
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  let base = existsSync(PROMPT_PATH) ? readFileSync(PROMPT_PATH, 'utf8') : DEFAULT_SYSTEM_PROMPT;
  const learnings = loadLearnings();
  const jobState = activeJob
    ? `\n\n## Current state\nA background job is running: "${activeJob.title}" (tool=${activeJob.toolName}, id=${activeJob.jobId}). You should NOT start another job of the same kind — ask the user or call check_job_status.`
    : '';
  const learnSection = learnings.trim() ? `\n\n${learnings.trim()}` : '';
  return `${base}${learnSection}${jobState}`;
}

const DEFAULT_SYSTEM_PROMPT = `You are a friendly project assistant talking to a client via Telegram. You have access to tools for doing actual work — prefer calling them over making things up. If a message is side chatter not addressed to you, call skip.`;

async function callAnthropic(body) {
  const r = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`anthropic ${r.status}: ${text.slice(0, 500)}`);
  }
  return r.json();
}

/**
 * Run one chat-agent turn against the current history.
 * Returns the assistant text to send to the user (or null if skipped).
 */
async function runTurn(chatId) {
  const tools = toolSchemas();
  let response = await callAnthropic({
    model: CHAT_MODEL,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    messages: history,
    tools,
  });

  // Tool-use loop
  while (response.stop_reason === 'tool_use') {
    const skipped = response.content.some(b => b.type === 'tool_use' && b.name === 'skip');
    if (skipped) {
      // Drop the trigger message from history — behave as if we never saw it.
      history.pop();
      saveHistory();
      log('chat: skip');
      return null;
    }

    const toolResults = [];
    const ctx = makeToolCtx(chatId);
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = await executeTool(block.name, block.input || {}, ctx);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    history.push(
      { role: 'assistant', content: response.content },
      { role: 'user',      content: toolResults },
    );
    saveHistory();

    response = await callAnthropic({
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(),
      messages: history,
      tools,
    });
  }

  history.push({ role: 'assistant', content: response.content });
  saveHistory();

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
  return text || null;
}

// ---------------------------------------------------------------------------
// Tool context (passed to plugin tools)
// ---------------------------------------------------------------------------

function makeToolCtx(chatId) {
  return {
    projectDir: process.cwd(),
    chatId,
    sendMessage: text => tg('sendMessage', { chat_id: chatId, text: truncate(text) }),
    editMessage: (messageId, text) =>
      tg('editMessageText', { chat_id: chatId, message_id: messageId, text: truncate(text) }),
    newJobId,
    backgroundJob(jobId, promise, cancel, meta = {}) {
      registerJob({
        jobId,
        toolName: meta.toolName || 'unknown',
        title: meta.title || '(untitled)',
        cancel,
        promise,
      });
    },
    busy: () => activeJob,
    log: (...args) => log('[tool]', ...args),
  };
}

// ---------------------------------------------------------------------------
// Turn queue (serialises user + system triggers per chat)
// ---------------------------------------------------------------------------

/** @type {Array<{chatId:string,type:'user'|'system',text:string}>} */
const turnQueue = [];
let turnRunning = false;

function enqueueTurn(trigger) {
  // System triggers don't carry a chatId — reuse the most recent chat.
  if (!trigger.chatId) trigger.chatId = lastChatId;
  if (!trigger.chatId) {
    log('no chatId for turn trigger, dropping');
    return;
  }
  turnQueue.push(trigger);
  kickTurnWorker();
}

async function kickTurnWorker() {
  if (turnRunning) return;
  turnRunning = true;
  try {
    while (turnQueue.length) {
      const trigger = turnQueue.shift();
      await processTrigger(trigger);
    }
  } finally {
    turnRunning = false;
  }
}

async function processTrigger({ chatId, type, text }) {
  history.push({ role: 'user', content: text });
  saveHistory();
  try {
    const reply = await runTurn(chatId);
    if (reply) await sendMessage(chatId, reply);
  } catch (e) {
    log('turn error', e?.message || e);
    if (type === 'user') {
      await sendMessage(chatId, `⚠️ error: ${e?.message || String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Slash commands (operator shortcuts, bypass the LLM)
// ---------------------------------------------------------------------------

async function handleSlash(text, chatId) {
  if (text === '/status') {
    if (!activeJob) return sendMessage(chatId, '💤 idle');
    const secs = Math.round((Date.now() - activeJob.startedAt) / 1000);
    return sendMessage(chatId, `🏃 ${activeJob.title}\n(tool=${activeJob.toolName}, id=${activeJob.jobId}, ${secs}s)`);
  }
  if (text === '/cancel') {
    if (!activeJob) return sendMessage(chatId, 'nothing to cancel');
    try { activeJob.cancel?.(); } catch {}
    return sendMessage(chatId, `🛑 cancel requested (${activeJob.jobId})`);
  }
  if (text === '/clear') {
    if (activeJob) return sendMessage(chatId, '⚠️ a job is running — /cancel first, then /clear');
    clearHistory();
    return sendMessage(chatId, '✨ history cleared — next message starts fresh');
  }
  if (text === '/help' || text === '/start') {
    return sendMessage(chatId, [
      'Hi — send me any message and I will help with this project.',
      '',
      'Operator shortcuts:',
      '/status — current job',
      '/cancel — cancel running job',
      '/clear  — wipe chat history',
      '/help   — this message',
    ].join('\n'));
  }
  return sendMessage(chatId, 'unknown command. try /status /cancel /clear /help');
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

let lastChatId = null;
let offset = 0;

async function main() {
  await loadTools();
  log(`listening in ${process.cwd()} (model=${CHAT_MODEL}, ${tools.size} tools: ${[...tools.keys()].join(', ')})`);
  process.on('SIGINT', () => { log('bye'); process.exit(0); });

  while (true) {
    const res = await tg('getUpdates', { offset, timeout: 30 });
    const updates = res?.result || [];
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m?.text) continue;
      const chatId = String(m.chat.id);
      if (TELEGRAM_ALLOWED.size && !TELEGRAM_ALLOWED.has(chatId)) continue;
      lastChatId = chatId;
      const text = m.text.trim();
      if (text.startsWith('/')) {
        handleSlash(text, chatId); // fire and forget
      } else {
        enqueueTurn({ chatId, type: 'user', text });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function truncate(text) {
  const s = String(text ?? '');
  return s.length > MAX_MSG ? s.slice(-MAX_MSG) : s;
}

function log(...args) {
  console.log('[nanogent]', ...args);
}

function die(msg) {
  console.error(`[nanogent] ${msg}`);
  process.exit(1);
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

// ---------------------------------------------------------------------------
main().catch(e => { console.error('[nanogent] fatal', e); process.exit(1); });
