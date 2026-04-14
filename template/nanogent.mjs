// nanogent.mjs — per-project chat agent core runtime.
//
// Owns:
//   - plugin loaders (tools / channels / providers)
//   - contacts.json parsing + access control
//   - turn queue + per-chat history routing
//   - chat-agent tool-use loop (delegates one round-trip at a time to provider)
//   - core tools (skip, check_job_status, cancel_job, learn)
//   - job registry with crash recovery + async completion routing
//   - slash commands
//
// Does NOT own:
//   - any specific transport (that's in .nanogent/channels/<name>/)
//   - any specific AI provider (that's in .nanogent/providers/<name>/)
//   - any specific capability (that's in .nanogent/tools/<name>/)
//
// See DESIGN.md at the repo root for decision rationale.

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------

const ENV_PATH       = '.nanogent/.env';
const CONFIG_PATH    = '.nanogent/config.json';
const CONTACTS_PATH  = '.nanogent/contacts.json';
const PROMPT_PATH    = '.nanogent/prompt.md';
const TOOLS_DIR      = '.nanogent/tools';
const CHANNELS_DIR   = '.nanogent/channels';
const PROVIDERS_DIR  = '.nanogent/providers';
const STATE_DIR      = '.nanogent/state';
const HISTORY_DIR    = `${STATE_DIR}/history`;
const LEARNINGS_PATH = `${STATE_DIR}/learnings.md`;
const JOBS_PATH      = `${STATE_DIR}/jobs.json`;

mkdirSync(STATE_DIR,   { recursive: true });
mkdirSync(HISTORY_DIR, { recursive: true });

// Load .env into process.env so plugins can read their own keys.
for (const [k, v] of Object.entries(loadEnv(ENV_PATH))) {
  if (process.env[k] === undefined) process.env[k] = v;
}

const config = loadConfig(CONFIG_PATH);
const contacts = loadContacts(CONTACTS_PATH);

const PROJECT_NAME = config.projectName || 'nanogent';
const CHAT_MODEL   = process.env.NANOGENT_CHAT_MODEL  || config.chatModel   || 'claude-haiku-4-5';
const MAX_HISTORY  = Number(process.env.NANOGENT_MAX_HISTORY || config.maxHistory || 80);
const MAX_TOKENS   = Number(process.env.NANOGENT_MAX_TOKENS  || config.maxTokens  || 1024);

// ---------------------------------------------------------------------------
// Learnings (global, appended by the learn core tool)
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
// Contact resolution & permission computation
// ---------------------------------------------------------------------------

/**
 * Look up a chat entry by (channel, chatId). Returns null if nothing matches.
 * Falls back to a wildcard entry (chatId === '*') for the channel if present.
 */
function findChat(channel, chatId) {
  const chats = contacts.chats || {};
  // Exact match first
  for (const [key, chat] of Object.entries(chats)) {
    if (chat.channel === channel && chat.chatId === chatId) {
      return { key, chat };
    }
  }
  // Wildcard fallback
  for (const [key, chat] of Object.entries(chats)) {
    if (chat.channel === channel && chat.chatId === '*') {
      return { key, chat };
    }
  }
  return null;
}

/**
 * Resolve an incoming message to an access decision + effective tool set.
 * Returns { allowed, reason, username?, displayName?, contactId, effectiveTools }
 * or { allowed: false, reason: 'unknown-chat' | 'chat-disabled' | 'unknown-user-no-guests' }.
 */
function resolveAccess({ channel, chatId, user }) {
  const match = findChat(channel, chatId);
  if (!match) return { allowed: false, reason: 'unknown-chat' };

  const { key: chatKey, chat } = match;
  if (chat.enabled === false) return { allowed: false, reason: 'chat-disabled' };

  // Resolve user to a username via chat.userMapping
  const mapping = chat.userMapping || {};
  const username = mapping[user.id];

  const users = contacts.users || {};
  const alwaysAllowed = contacts.alwaysAllowed || ['skip'];
  const installedToolNames = [...tools.keys()];

  let effectiveTools;
  let displayName;
  let isGuest;

  if (username && users[username]) {
    // Known user
    const userTools = users[username].tools || [];
    const chatUserTools = chat.userTools;
    const intersected = chatUserTools
      ? userTools.filter(t => chatUserTools.includes(t))
      : userTools;
    effectiveTools = unique([...alwaysAllowed, ...intersected]).filter(t => installedToolNames.includes(t));
    displayName = users[username].displayName || user.displayName || `user:${user.id}`;
    isGuest = false;
  } else {
    // Unknown user → guest handling
    if (!chat.allowGuests) {
      return { allowed: false, reason: 'unknown-user-no-guests', chatKey };
    }
    const guestTools = chat.guestTools || [];
    effectiveTools = unique([...alwaysAllowed, ...guestTools]).filter(t => installedToolNames.includes(t));
    displayName = user.displayName || `user:${user.id}`;
    isGuest = true;
  }

  // contactId = key for history lookup
  const historyMode = chat.historyMode || (chat.chatId === '*' ? 'per-user' : 'shared');
  const contactId = historyMode === 'per-user'
    ? `${chatKey}/${sanitize(user.id)}`
    : chatKey;

  return {
    allowed:   true,
    chatKey,
    chat,
    username,
    displayName,
    isGuest,
    contactId,
    effectiveTools,
    historyMode,
  };
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function unique(arr) {
  return Array.from(new Set(arr));
}

// ---------------------------------------------------------------------------
// History (per contactId)
// ---------------------------------------------------------------------------

/** @type {Map<string, Array<{role:string,content:any}>>} */
const historyCache = new Map();

function historyPath(contactId) {
  return join(HISTORY_DIR, `${contactId.replace(/\//g, '__')}.jsonl`);
}

function loadHistoryFor(contactId) {
  if (historyCache.has(contactId)) return historyCache.get(contactId);
  const p = historyPath(contactId);
  let h = [];
  if (existsSync(p)) {
    try {
      h = readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch (e) { log('history load error', contactId, e?.message || e); }
  }
  historyCache.set(contactId, h);
  return h;
}

function saveHistoryFor(contactId) {
  let h = historyCache.get(contactId) || [];
  if (h.length > MAX_HISTORY) {
    h = rotateHistory(h);
    historyCache.set(contactId, h);
  }
  const p = historyPath(contactId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, h.map(m => JSON.stringify(m)).join('\n') + '\n');
}

function clearHistoryFor(contactId) {
  historyCache.set(contactId, []);
  try { unlinkSync(historyPath(contactId)); } catch {}
}

function isTurnStart(message) {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return true;
  if (!Array.isArray(message.content)) return false;
  return !message.content.some(b => b?.type === 'tool_result');
}

/**
 * Boundary-aware rotation — never leaves an orphan tool_result at head.
 */
function rotateHistory(h) {
  if (h.length <= MAX_HISTORY) return h;
  const minStart = h.length - MAX_HISTORY;
  for (let i = minStart; i < h.length; i++) {
    if (isTurnStart(h[i])) return h.slice(i);
  }
  for (let i = h.length - 1; i >= 0; i--) {
    if (isTurnStart(h[i])) return h.slice(i);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Plugin loaders
// ---------------------------------------------------------------------------

/** @type {Map<string, any>} toolName → tool object */
const tools = new Map();
/** @type {Map<string, string>} toolName → absolute tool dir */
const toolDirs = new Map();
/** @type {Map<string, any>} channelName → channel object */
const channels = new Map();
/** @type {any} the active provider object */
let provider = null;

async function loadPluginsFromDir(dir, kind) {
  const loaded = [];
  if (!existsSync(dir)) return loaded;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    const indexPath = resolve(dir, entry.name, 'index.mjs');
    if (!existsSync(indexPath)) {
      log(`${kind} ${entry.name}: missing index.mjs, skipping`);
      continue;
    }
    try {
      const mod = await import(pathToFileURL(indexPath).href);
      const plugin = mod.default;
      if (!plugin?.name) {
        log(`${kind} ${entry.name}: missing 'name' export, skipping`);
        continue;
      }
      loaded.push({ plugin, dir: resolve(dir, entry.name), entryName: entry.name });
    } catch (e) {
      log(`${kind} ${entry.name}: load error`, e?.message || e);
    }
  }
  return loaded;
}

async function loadAllPlugins() {
  // Core tools — always present, not in .nanogent/tools/
  tools.set('skip', {
    name: 'skip',
    description:
      'Call this when the incoming message is NOT directed at you (side conversations, chatter meant for '
      + 'other humans, off-topic messages in groups). Do not reply with text when you skip.',
    input_schema: { type: 'object', properties: {}, required: [] },
  });
  tools.set('check_job_status', {
    name: 'check_job_status',
    description: 'Check what background job is currently running and how long it has been running. Use when the user asks about progress.',
    input_schema: { type: 'object', properties: {}, required: [] },
  });
  tools.set('cancel_job', {
    name: 'cancel_job',
    description: 'Cancel the currently running background job. Use when the user explicitly asks to stop or change direction.',
    input_schema: { type: 'object', properties: {}, required: [] },
  });
  tools.set('learn', {
    name: 'learn',
    description: 'Save a persistent note about this project or client — preferences, conventions, tone, tech stack. These are added to your system prompt on every future turn.',
    input_schema: {
      type: 'object',
      properties: {
        title:   { type: 'string', description: 'Short slug-like title (e.g. "prefers-british-english").' },
        content: { type: 'string', description: 'The fact to remember and why it matters.' },
      },
      required: ['title', 'content'],
    },
  });

  // Plugin tools
  for (const { plugin, dir, entryName } of await loadPluginsFromDir(TOOLS_DIR, 'tool')) {
    if (typeof plugin.execute !== 'function') {
      log(`tool ${entryName}: missing execute(), skipping`);
      continue;
    }
    tools.set(plugin.name, plugin);
    toolDirs.set(plugin.name, dir);
    log(`loaded tool: ${plugin.name} (${entryName}/index.mjs)`);
  }

  // Channel plugins
  for (const { plugin, entryName } of await loadPluginsFromDir(CHANNELS_DIR, 'channel')) {
    if (typeof plugin.start !== 'function' || typeof plugin.sendMessage !== 'function') {
      log(`channel ${entryName}: missing start() or sendMessage(), skipping`);
      continue;
    }
    channels.set(plugin.name, plugin);
    log(`loaded channel: ${plugin.name}`);
  }
  if (channels.size === 0) {
    die('no channels loaded — install at least one channel plugin under .nanogent/channels/');
  }

  // Provider plugins — exactly one
  const providerEntries = await loadPluginsFromDir(PROVIDERS_DIR, 'provider');
  if (providerEntries.length === 0) {
    die('no provider loaded — install exactly one provider under .nanogent/providers/');
  }
  if (providerEntries.length > 1) {
    log(`warning: multiple providers found (${providerEntries.map(p => p.plugin.name).join(', ')}) — using first: ${providerEntries[0].plugin.name}`);
  }
  provider = providerEntries[0].plugin;
  if (typeof provider.chat !== 'function') {
    die(`provider ${provider.name}: missing chat() method`);
  }
  log(`loaded provider: ${provider.name}`);
}

// ---------------------------------------------------------------------------
// Job registry (in-memory + crash-recovery persistence)
// ---------------------------------------------------------------------------

/**
 * @type {null | {
 *   jobId: string, toolName: string, title: string, startedAt: number,
 *   cancel: () => void,
 *   origin: { channel: string, chatId: string, contactId: string, displayName: string }
 * }}
 */
let activeJob = null;

function newJobId() { return randomUUID().slice(0, 8); }

function persistActiveJob() {
  try {
    if (activeJob) {
      writeFileSync(JOBS_PATH, JSON.stringify({
        jobId:     activeJob.jobId,
        toolName:  activeJob.toolName,
        title:     activeJob.title,
        startedAt: activeJob.startedAt,
        origin:    activeJob.origin,
      }) + '\n');
    } else {
      try { unlinkSync(JOBS_PATH); } catch {}
    }
  } catch (e) { log('job persist error', e?.message || e); }
}

function recoverInterruptedJob() {
  if (!existsSync(JOBS_PATH)) return;
  let stale;
  try {
    stale = JSON.parse(readFileSync(JOBS_PATH, 'utf8'));
  } catch { try { unlinkSync(JOBS_PATH); } catch {}; return; }
  try { unlinkSync(JOBS_PATH); } catch {}
  if (!stale?.jobId || !stale?.origin?.contactId) return;
  const elapsed = Math.round((Date.now() - (stale.startedAt || Date.now())) / 1000);
  log(`recovered interrupted job: ${stale.jobId} (${stale.toolName}, "${stale.title}", ~${elapsed}s old)`);
  const h = loadHistoryFor(stale.origin.contactId);
  h.push({
    role: 'user',
    content: `[SYSTEM] Tool '${stale.toolName}' (job ${stale.jobId}, "${stale.title}") was INTERRUPTED by a restart after ~${elapsed}s. The job's final status is unknown — any file changes it made before the restart are still on disk, but we don't have its output. If the user asks about it, acknowledge the interruption and offer to retry.`,
  });
  saveHistoryFor(stale.origin.contactId);
}

function registerJob({ jobId, toolName, title, cancel, promise, origin }) {
  activeJob = { jobId, toolName, title, startedAt: Date.now(), cancel, origin };
  persistActiveJob();
  promise.then(
    result => onJobComplete(jobId, 'completed', result),
    err    => onJobComplete(jobId, 'failed', err?.message || String(err)),
  );
}

function onJobComplete(jobId, status, result) {
  if (!activeJob || activeJob.jobId !== jobId) return;
  const { toolName, title, startedAt, origin } = activeJob;
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  activeJob = null;
  persistActiveJob();
  const body = typeof result === 'string' ? result : JSON.stringify(result);
  // Feed a synthetic [SYSTEM] turn trigger for the originating chat.
  enqueueTurn({
    channel:  origin.channel,
    chatId:   origin.chatId,
    contactId: origin.contactId,
    displayName: 'SYSTEM',
    isGuest:  false,
    effectiveTools: null, // recompute at turn time using the originating chat
    text: `[SYSTEM] Tool '${toolName}' (job ${jobId}, "${title}") ${status} after ${elapsed}s:\n${body}`,
    isSystemTrigger: true,
  });
}

// ---------------------------------------------------------------------------
// Core tool handlers
// ---------------------------------------------------------------------------

function coreCheckJobStatus() {
  if (!activeJob) return 'No job running. Idle.';
  const secs = Math.round((Date.now() - activeJob.startedAt) / 1000);
  return `Running: '${activeJob.title}' (tool=${activeJob.toolName}, id=${activeJob.jobId}, ${secs}s elapsed).`;
}

function coreCancelJob() {
  if (!activeJob) return 'No job to cancel.';
  try { activeJob.cancel?.(); return `Cancel requested for '${activeJob.title}' (id=${activeJob.jobId}).`; }
  catch (e) { return `Cancel attempted but threw: ${e?.message || String(e)}`; }
}

function coreLearn({ title, content }) {
  if (!title || !content) return 'error: learn requires both title and content';
  appendLearning(title, content);
  return `Saved: "${title}"`;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(name, input, origin) {
  const tool = tools.get(name);
  if (!tool) return `error: unknown tool '${name}'`;

  if (name === 'skip')              return { skip: true };
  if (name === 'check_job_status')  return coreCheckJobStatus();
  if (name === 'cancel_job')        return coreCancelJob();
  if (name === 'learn')             return coreLearn(input || {});

  // Plugin tool — build ctx with this tool's own folder and origin info.
  const ctx = makeToolCtx(origin, toolDirs.get(name));
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

function makeToolCtx(origin, toolDir) {
  const channel = channels.get(origin.channel);
  return {
    projectName: PROJECT_NAME,
    projectDir:  process.cwd(),
    toolDir,
    channel:     origin.channel,
    chatId:      origin.chatId,
    contactId:   origin.contactId,
    async sendMessage(text) {
      return channel?.sendMessage(origin.chatId, text);
    },
    async editMessage(handle, text) {
      return channel?.editMessage(origin.chatId, handle, text);
    },
    newJobId,
    backgroundJob(jobId, promise, cancel, meta = {}) {
      registerJob({
        jobId,
        toolName: meta.toolName || 'unknown',
        title:    meta.title    || '(untitled)',
        cancel,
        promise,
        origin,
      });
    },
    busy: () => activeJob,
    log: (...args) => log(`[tool:${origin.channel}]`, ...args),
  };
}

// ---------------------------------------------------------------------------
// Chat-agent turn execution
// ---------------------------------------------------------------------------

function buildSystemPrompt() {
  const base = existsSync(PROMPT_PATH) ? readFileSync(PROMPT_PATH, 'utf8') : DEFAULT_SYSTEM_PROMPT;
  const project = `\n\n## Project\nYou are operating inside the "${PROJECT_NAME}" nanogent project.`;
  const learnings = loadLearnings();
  const jobState = activeJob
    ? `\n\n## Current state\nA background job is running: "${activeJob.title}" (tool=${activeJob.toolName}, id=${activeJob.jobId}). Do not start another job of the same kind — ask the user or call check_job_status.`
    : '';
  const learnSection = learnings.trim() ? `\n\n${learnings.trim()}` : '';
  const dynamic = `${project}${learnSection}${jobState}`;
  const blocks = [{ type: 'text', text: base, cache_control: { type: 'ephemeral' } }];
  if (dynamic) blocks.push({ type: 'text', text: dynamic });
  return blocks;
}

const DEFAULT_SYSTEM_PROMPT = `You are a friendly project assistant talking to a client via chat. You have access to tools for doing real work — prefer calling them over making things up. If a message is side chatter not addressed to you, call skip. User messages are always prefixed with [Name]: — use the name to address speakers and tell participants apart in group chats.`;

function toolSchemasFor(effectiveTools) {
  const arr = effectiveTools
    .map(name => tools.get(name))
    .filter(Boolean)
    .map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  if (arr.length > 0) {
    arr[arr.length - 1].cache_control = { type: 'ephemeral' };
  }
  return arr;
}

/**
 * Run one chat-agent turn against the given contact's history.
 * Returns the assistant text to send back (or null if skipped).
 */
async function runTurn(origin, effectiveTools) {
  const history = loadHistoryFor(origin.contactId);
  const toolList = toolSchemasFor(effectiveTools);

  let response = await provider.chat({
    model:     CHAT_MODEL,
    maxTokens: MAX_TOKENS,
    system:    buildSystemPrompt(),
    messages:  history,
    tools:     toolList,
  });

  while (response.stopReason === 'tool_use') {
    const skipped = response.content.some(b => b.type === 'tool_use' && b.name === 'skip');
    if (skipped) {
      // Drop the trigger message from history — behave as if we never saw it.
      history.pop();
      saveHistoryFor(origin.contactId);
      log(`[${origin.contactId}] skip`);
      return null;
    }

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const result = await executeTool(block.name, block.input || {}, origin);
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
    saveHistoryFor(origin.contactId);

    response = await provider.chat({
      model:     CHAT_MODEL,
      maxTokens: MAX_TOKENS,
      system:    buildSystemPrompt(),
      messages:  history,
      tools:     toolList,
    });
  }

  history.push({ role: 'assistant', content: response.content });
  saveHistoryFor(origin.contactId);

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
  return text || null;
}

// ---------------------------------------------------------------------------
// Turn queue (per contactId — serialises per conversation, not per process)
// ---------------------------------------------------------------------------

/** @type {Array<any>} */
const turnQueue = [];
let turnRunning = false;

function enqueueTurn(trigger) {
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

async function processTrigger(trigger) {
  const { channel, chatId, contactId, displayName, text, effectiveTools, isSystemTrigger } = trigger;

  // For system triggers (job completion, recovery), recompute effective tools
  // from the origin chat so the chat agent has the same permissions it would
  // have had when triggered by a fresh user message.
  let perTurnTools = effectiveTools;
  if (isSystemTrigger || !perTurnTools) {
    const match = findChat(channel, chatId);
    if (!match) { log('system trigger for unknown chat, dropping'); return; }
    // System messages don't belong to a specific caller, so we grant the
    // union of alwaysAllowed and the chat's userTools (the superset a known
    // user in this chat could access) intersected with installed tools.
    const chat = match.chat;
    const alwaysAllowed = contacts.alwaysAllowed || ['skip'];
    const chatUserTools = chat.userTools || [];
    const installed = [...tools.keys()];
    perTurnTools = unique([...alwaysAllowed, ...chatUserTools]).filter(t => installed.includes(t));
  }

  const origin = { channel, chatId, contactId };
  const history = loadHistoryFor(contactId);

  const prefix = isSystemTrigger ? '' : `[${displayName}]: `;
  history.push({ role: 'user', content: prefix + text });
  saveHistoryFor(contactId);

  try {
    const reply = await runTurn(origin, perTurnTools);
    if (reply) {
      const ch = channels.get(channel);
      if (ch) await ch.sendMessage(chatId, reply);
    }
  } catch (e) {
    log('turn error', e?.message || e);
    if (!isSystemTrigger) {
      const ch = channels.get(channel);
      if (ch) await ch.sendMessage(chatId, `⚠️ error: ${e?.message || String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Slash commands (operator shortcuts, bypass the LLM)
// ---------------------------------------------------------------------------

async function handleSlash(text, origin) {
  const ch = channels.get(origin.channel);
  if (!ch) return;
  const say = t => ch.sendMessage(origin.chatId, t);

  if (text === '/status') {
    if (!activeJob) return say('💤 idle');
    const secs = Math.round((Date.now() - activeJob.startedAt) / 1000);
    return say(`🏃 ${activeJob.title}\n(tool=${activeJob.toolName}, id=${activeJob.jobId}, ${secs}s)`);
  }
  if (text === '/cancel') {
    if (!activeJob) return say('nothing to cancel');
    try { activeJob.cancel?.(); } catch {}
    return say(`🛑 cancel requested (${activeJob.jobId})`);
  }
  if (text === '/clear') {
    if (activeJob) return say('⚠️ a job is running — /cancel first, then /clear');
    clearHistoryFor(origin.contactId);
    return say('✨ history cleared — next message starts fresh');
  }
  if (text === '/help' || text === '/start') {
    return say([
      `Hi — send me any message and I will help with the "${PROJECT_NAME}" project.`,
      '',
      'Operator shortcuts:',
      '/status — current job',
      '/cancel — cancel running job',
      '/clear  — wipe chat history',
      '/help   — this message',
    ].join('\n'));
  }
  return say('unknown command. try /status /cancel /clear /help');
}

// ---------------------------------------------------------------------------
// Channel plugin ctx — passed to each channel's start()
// ---------------------------------------------------------------------------

function makeChannelCtx(channelName) {
  return {
    projectName: PROJECT_NAME,

    /**
     * Look up a chat by (channel, chatId). Returns the chat config object
     * (including mode, historyMode, etc.) or null if unknown.
     */
    getChatConfig(channel, chatId) {
      const match = findChat(channel, chatId);
      return match ? match.chat : null;
    },

    /**
     * Called by the channel plugin when a message is ready to hand off to
     * the core. The plugin has already done any mode-based filtering.
     */
    onMessage(msg) {
      handleIncomingMessage(msg);
    },

    log: (...args) => log(`[channel:${channelName}]`, ...args),
  };
}

function handleIncomingMessage(msg) {
  const { channel, chatId, user, text } = msg;
  const trimmed = (text || '').trim();
  if (!trimmed) return;

  // Resolve access (allowlist + permission).
  const access = resolveAccess({ channel, chatId, user });
  if (!access.allowed) {
    log(`drop [${access.reason}] channel=${channel} chatId=${chatId} user=${user.id} name="${user.displayName || ''}" preview="${trimmed.slice(0, 60)}"`);
    return;
  }

  const origin = {
    channel,
    chatId,
    contactId: access.contactId,
  };

  // Slash commands bypass the chat agent entirely.
  if (trimmed.startsWith('/')) {
    handleSlash(trimmed, origin);
    return;
  }

  enqueueTurn({
    ...origin,
    displayName:    access.displayName,
    isGuest:        access.isGuest,
    effectiveTools: access.effectiveTools,
    text:           trimmed,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const channelStopFns = [];

async function main() {
  await loadAllPlugins();
  recoverInterruptedJob();

  for (const [name, channel] of channels) {
    try {
      const stop = await channel.start(makeChannelCtx(name));
      if (typeof stop === 'function') channelStopFns.push(stop);
    } catch (e) {
      log(`channel ${name}: start failed —`, e?.message || e);
    }
  }

  log(`listening: project="${PROJECT_NAME}" model=${CHAT_MODEL} channels=[${[...channels.keys()].join(',')}] tools=[${[...tools.keys()].join(',')}] provider=${provider.name}`);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function shutdown() {
  log('bye');
  for (const stop of channelStopFns) {
    try { stop(); } catch {}
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function log(...args) {
  console.log(`[nanogent project=${PROJECT_NAME}]`, ...args);
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

function loadConfig(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { console.error(`[nanogent] warning: failed to parse ${path}: ${e?.message || e}`); return {}; }
}

function loadContacts(path) {
  if (!existsSync(path)) return { alwaysAllowed: ['skip'], users: {}, chats: {} };
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    return {
      alwaysAllowed: c.alwaysAllowed || ['skip'],
      users:         c.users || {},
      chats:         c.chats || {},
    };
  } catch (e) {
    console.error(`[nanogent] warning: failed to parse ${path}: ${e?.message || e}`);
    return { alwaysAllowed: ['skip'], users: {}, chats: {} };
  }
}

// ---------------------------------------------------------------------------
main().catch(e => { console.error('[nanogent] fatal', e); process.exit(1); });
