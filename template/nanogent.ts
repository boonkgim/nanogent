// nanogent.ts — per-project chat agent core runtime.
//
// Owns:
//   - plugin loaders (tools / channels / providers / history / memory / scheduler)
//   - contacts.json parsing + access control
//   - turn queue + per-contact turn routing
//   - chat-agent tool-use loop (delegates one round-trip at a time to provider)
//   - core tools (skip, check_job_status, cancel_job, learn)
//   - job registry with crash recovery + async completion routing
//   - scheduler tick loop + fireSystemTurn entry point for non-user turns
//   - slash commands
//
// Does NOT own:
//   - any specific transport (that's in .nanogent/channels/<name>/)
//   - any specific AI provider (that's in .nanogent/providers/<name>/)
//   - any specific capability (that's in .nanogent/tools/<name>/)
//   - history storage format (that's in .nanogent/history/<name>/)
//   - retrieval / windowing / RAG (that's in .nanogent/memory/<name>/)
//   - schedule storage or cron parsing (that's in .nanogent/scheduler/<name>/)
//
// See DESIGN.md at the repo root for decision rationale.

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import type {
  ActiveJob, AccessDecision, ChannelCtx, ChannelPlugin, ChatEntry, Config, Contacts,
  ContentBlock, HistoryMessage, HistoryStorePlugin, IncomingMessage, MemoryPlugin,
  ProviderPlugin, SchedulerPlugin, TextBlock, ToolCtx, ToolPlugin, ToolSchema,
  ToolUseBlock,
} from './types.d.ts';

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
const HISTORY_DIR    = '.nanogent/history';
const MEMORY_DIR     = '.nanogent/memory';
const SCHEDULER_DIR  = '.nanogent/scheduler';
const STATE_DIR      = '.nanogent/state';
const LEARNINGS_PATH = `${STATE_DIR}/learnings.md`;
const JOBS_PATH      = `${STATE_DIR}/jobs.json`;

// Module-level runtime state. Populated by bootstrap() so that importing this
// module from tests has no filesystem side effects.
let config: Config = {};
let contacts: Contacts = { alwaysAllowed: ['skip'], users: {}, chats: {} };
let PROJECT_NAME = 'nanogent';
let CHAT_MODEL   = 'claude-haiku-4-5';
let MAX_TOKENS   = 1024;

function bootstrap(): void {
  mkdirSync(STATE_DIR, { recursive: true });

  // Load .env into process.env so plugins can read their own keys.
  for (const [k, v] of Object.entries(loadEnv(ENV_PATH))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }

  config = loadConfig(CONFIG_PATH);
  contacts = loadContacts(CONTACTS_PATH);

  PROJECT_NAME = config.projectName || 'nanogent';
  CHAT_MODEL   = process.env.NANOGENT_CHAT_MODEL  || config.chatModel   || 'claude-haiku-4-5';
  MAX_TOKENS   = Number(process.env.NANOGENT_MAX_TOKENS  || config.maxTokens  || 1024);
}

// ---------------------------------------------------------------------------
// Learnings (global, appended by the learn core tool)
// ---------------------------------------------------------------------------

function loadLearnings(): string {
  if (!existsSync(LEARNINGS_PATH)) return '';
  try { return readFileSync(LEARNINGS_PATH, 'utf8'); } catch { return ''; }
}

function appendLearning(title: string, content: string): void {
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
 * Pure — takes contacts as input.
 */
export function findChat(
  contactsArg: Contacts,
  channel: string,
  chatId: string,
): { key: string; chat: ChatEntry } | null {
  const chats = contactsArg.chats || {};
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
 * Pure — takes contacts + installed tool names as inputs.
 */
export function resolveAccess(
  contactsArg: Contacts,
  installedToolNames: string[],
  { channel, chatId, user }: { channel: string; chatId: string; user: { id: string; displayName?: string } },
): AccessDecision {
  const match = findChat(contactsArg, channel, chatId);
  if (!match) return { allowed: false, reason: 'unknown-chat' };

  const { key: chatKey, chat } = match;
  if (chat.enabled === false) return { allowed: false, reason: 'chat-disabled', chatKey };

  // Resolve user to a username via chat.userMapping
  const mapping = chat.userMapping || {};
  const username = mapping[user.id];

  const users = contactsArg.users || {};
  const alwaysAllowed = contactsArg.alwaysAllowed || ['skip'];

  let effectiveTools: string[];
  let displayName: string;
  let isGuest: boolean;

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
  const historyMode: 'shared' | 'per-user' =
    chat.historyMode || (chat.chatId === '*' ? 'per-user' : 'shared');
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

export function sanitize(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

export function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// ---------------------------------------------------------------------------
// Plugin loaders
// ---------------------------------------------------------------------------

const tools = new Map<string, ToolPlugin | ToolSchema>();
const toolDirs = new Map<string, string>();
const channels = new Map<string, ChannelPlugin>();
let provider: ProviderPlugin | null = null;
let history: HistoryStorePlugin | null = null;
let memory: MemoryPlugin | null = null;
let scheduler: SchedulerPlugin | null = null;

interface LoadedPlugin<T> {
  plugin: T;
  dir: string;
  entryName: string;
}

async function loadPluginsFromDir<T extends { name?: string }>(
  dir: string,
  kind: string,
): Promise<LoadedPlugin<T>[]> {
  const loaded: LoadedPlugin<T>[] = [];
  if (!existsSync(dir)) return loaded;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;
    const indexPath = resolve(dir, entry.name, 'index.ts');
    if (!existsSync(indexPath)) {
      log(`${kind} ${entry.name}: missing index.ts, skipping`);
      continue;
    }
    try {
      const mod = await import(pathToFileURL(indexPath).href) as { default?: T };
      const plugin = mod.default;
      if (!plugin?.name) {
        log(`${kind} ${entry.name}: missing 'name' export, skipping`);
        continue;
      }
      loaded.push({ plugin, dir: resolve(dir, entry.name), entryName: entry.name });
    } catch (e) {
      log(`${kind} ${entry.name}: load error`, (e as Error)?.message || e);
    }
  }
  return loaded;
}

async function loadAllPlugins(): Promise<void> {
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
  for (const { plugin, dir, entryName } of await loadPluginsFromDir<ToolPlugin>(TOOLS_DIR, 'tool')) {
    if (typeof plugin.execute !== 'function') {
      log(`tool ${entryName}: missing execute(), skipping`);
      continue;
    }
    tools.set(plugin.name, plugin);
    toolDirs.set(plugin.name, dir);
    log(`loaded tool: ${plugin.name} (${entryName}/index.ts)`);
  }

  // Channel plugins
  for (const { plugin, entryName } of await loadPluginsFromDir<ChannelPlugin>(CHANNELS_DIR, 'channel')) {
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
  const providerEntries = await loadPluginsFromDir<ProviderPlugin>(PROVIDERS_DIR, 'provider');
  if (providerEntries.length === 0) {
    die('no provider loaded — install exactly one provider under .nanogent/providers/');
  }
  if (providerEntries.length > 1) {
    log(`warning: multiple providers found (${providerEntries.map(p => p.plugin.name).join(', ')}) — using first: ${providerEntries[0]!.plugin.name}`);
  }
  provider = providerEntries[0]!.plugin;
  if (typeof provider.chat !== 'function') {
    die(`provider ${provider.name}: missing chat() method`);
  }
  log(`loaded provider: ${provider.name}`);

  // History store plugins — exactly one
  const historyEntries = await loadPluginsFromDir<HistoryStorePlugin>(HISTORY_DIR, 'history');
  if (historyEntries.length === 0) {
    die('no history store loaded — install exactly one history plugin under .nanogent/history/');
  }
  if (historyEntries.length > 1) {
    log(`warning: multiple history stores found (${historyEntries.map(h => h.plugin.name).join(', ')}) — using first: ${historyEntries[0]!.plugin.name}`);
  }
  const historyEntry = historyEntries[0]!;
  history = historyEntry.plugin;
  if (typeof history.append !== 'function' || typeof history.read !== 'function') {
    die(`history ${history.name}: missing required methods`);
  }
  await history.init({
    projectName: PROJECT_NAME,
    projectDir:  process.cwd(),
    stateDir:    STATE_DIR,
    pluginDir:   historyEntry.dir,
    log:         (...args) => { log(`[history:${history!.name}]`, ...args); },
  });
  log(`loaded history: ${history.name}`);

  // Memory plugins — exactly one
  const memoryEntries = await loadPluginsFromDir<MemoryPlugin>(MEMORY_DIR, 'memory');
  if (memoryEntries.length === 0) {
    die('no memory plugin loaded — install exactly one memory plugin under .nanogent/memory/');
  }
  if (memoryEntries.length > 1) {
    log(`warning: multiple memory plugins found (${memoryEntries.map(m => m.plugin.name).join(', ')}) — using first: ${memoryEntries[0]!.plugin.name}`);
  }
  const memoryEntry = memoryEntries[0]!;
  memory = memoryEntry.plugin;
  if (typeof memory.recall !== 'function') {
    die(`memory ${memory.name}: missing recall() method`);
  }
  await memory.init({
    projectName: PROJECT_NAME,
    projectDir:  process.cwd(),
    stateDir:    STATE_DIR,
    pluginDir:   memoryEntry.dir,
    history,
    log:         (...args) => { log(`[memory:${memory!.name}]`, ...args); },
  });
  log(`loaded memory: ${memory.name}`);

  // Scheduler plugins — OPTIONAL (zero or one). If none is loaded,
  // scheduling features silently degrade: the tick loop is a no-op and the
  // bundled `schedule` tool surfaces a clear "scheduler not available" error.
  const schedulerEntries = await loadPluginsFromDir<SchedulerPlugin>(SCHEDULER_DIR, 'scheduler');
  if (schedulerEntries.length > 1) {
    log(`warning: multiple schedulers found (${schedulerEntries.map(s => s.plugin.name).join(', ')}) — using first: ${schedulerEntries[0]!.plugin.name}`);
  }
  if (schedulerEntries.length >= 1) {
    const schedulerEntry = schedulerEntries[0]!;
    scheduler = schedulerEntry.plugin;
    if (typeof scheduler.claimDue !== 'function' || typeof scheduler.createSchedule !== 'function') {
      die(`scheduler ${scheduler.name}: missing required methods`);
    }
    await scheduler.init({
      projectName: PROJECT_NAME,
      projectDir:  process.cwd(),
      stateDir:    STATE_DIR,
      pluginDir:   schedulerEntry.dir,
      log:         (...args) => { log(`[scheduler:${scheduler!.name}]`, ...args); },
    });
    log(`loaded scheduler: ${scheduler.name}`);
  }
}

// ---------------------------------------------------------------------------
// Job registry (in-memory + crash-recovery persistence)
// ---------------------------------------------------------------------------

interface RuntimeJob extends ActiveJob {
  cancel: () => void;
  origin: { channel: string; chatId: string; contactId: string; displayName: string };
}

let activeJob: RuntimeJob | null = null;

function newJobId(): string { return randomUUID().slice(0, 8); }

function persistActiveJob(): void {
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
      try { unlinkSync(JOBS_PATH); } catch { /* ignore */ }
    }
  } catch (e) { log('job persist error', (e as Error)?.message || e); }
}

async function recoverInterruptedJob(): Promise<void> {
  if (!existsSync(JOBS_PATH)) return;
  let stale: RuntimeJob | null = null;
  try {
    stale = JSON.parse(readFileSync(JOBS_PATH, 'utf8')) as RuntimeJob;
  } catch { try { unlinkSync(JOBS_PATH); } catch { /* ignore */ } return; }
  try { unlinkSync(JOBS_PATH); } catch { /* ignore */ }
  if (!stale?.jobId || !stale?.origin?.contactId) return;
  const elapsed = Math.round((Date.now() - (stale.startedAt || Date.now())) / 1000);
  log(`recovered interrupted job: ${stale.jobId} (${stale.toolName}, "${stale.title}", ~${elapsed}s old)`);
  const note: HistoryMessage = {
    role: 'user',
    content: `[SYSTEM] Tool '${stale.toolName}' (job ${stale.jobId}, "${stale.title}") was INTERRUPTED by a restart after ~${elapsed}s. The job's final status is unknown — any file changes it made before the restart are still on disk, but we don't have its output. If the user asks about it, acknowledge the interruption and offer to retry.`,
  };
  await commitMessages(stale.origin.contactId, [note]);
}

interface RegisterJobArgs {
  jobId: string;
  toolName: string;
  title: string;
  cancel: () => void;
  promise: Promise<unknown>;
  origin: { channel: string; chatId: string; contactId: string; displayName: string };
}

function registerJob({ jobId, toolName, title, cancel, promise, origin }: RegisterJobArgs): void {
  activeJob = { jobId, toolName, title, startedAt: Date.now(), cancel, origin };
  persistActiveJob();
  promise.then(
    result => { onJobComplete(jobId, 'completed', result); },
    err    => { onJobComplete(jobId, 'failed', (err as Error)?.message || String(err)); },
  );
}

function onJobComplete(jobId: string, status: string, result: unknown): void {
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

function coreCheckJobStatus(): string {
  if (!activeJob) return 'No job running. Idle.';
  const secs = Math.round((Date.now() - activeJob.startedAt) / 1000);
  return `Running: '${activeJob.title}' (tool=${activeJob.toolName}, id=${activeJob.jobId}, ${secs}s elapsed).`;
}

function coreCancelJob(): string {
  if (!activeJob) return 'No job to cancel.';
  try { activeJob.cancel?.(); return `Cancel requested for '${activeJob.title}' (id=${activeJob.jobId}).`; }
  catch (e) { return `Cancel attempted but threw: ${(e as Error)?.message || String(e)}`; }
}

function coreLearn({ title, content }: { title?: string; content?: string }): string {
  if (!title || !content) return 'error: learn requires both title and content';
  appendLearning(title, content);
  return `Saved: "${title}"`;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

interface Origin { channel: string; chatId: string; contactId: string }

async function executeTool(
  name: string,
  input: Record<string, any>,
  origin: Origin,
): Promise<unknown> {
  const tool = tools.get(name);
  if (!tool) return `error: unknown tool '${name}'`;

  if (name === 'skip')              return { skip: true };
  if (name === 'check_job_status')  return coreCheckJobStatus();
  if (name === 'cancel_job')        return coreCancelJob();
  if (name === 'learn')             return coreLearn(input || {});

  // Plugin tool — build ctx with this tool's own folder and origin info.
  const toolDir = toolDirs.get(name);
  if (!toolDir || typeof (tool as ToolPlugin).execute !== 'function') {
    return `error: tool '${name}' is not executable`;
  }
  const ctx = makeToolCtx(origin, toolDir);
  try {
    const res = await (tool as ToolPlugin).execute(input || {}, ctx);
    if (typeof res === 'object' && res && 'async' in res && res.async && res.jobId) {
      return res.content || `Job ${res.jobId} started — you'll be notified on completion.`;
    }
    if (typeof res === 'string') return res;
    if (res && typeof res === 'object' && 'content' in res) return res.content ?? JSON.stringify(res);
    return JSON.stringify(res ?? {});
  } catch (e) {
    return `error: tool '${name}' threw: ${(e as Error)?.message || String(e)}`;
  }
}

function makeToolCtx(origin: Origin, toolDir: string): ToolCtx {
  const channel = channels.get(origin.channel);
  return {
    projectName: PROJECT_NAME,
    projectDir:  process.cwd(),
    toolDir,
    channel:     origin.channel,
    chatId:      origin.chatId,
    contactId:   origin.contactId,
    async sendMessage(text: string) {
      return channel?.sendMessage(origin.chatId, text) ?? null;
    },
    async editMessage(handle, text) {
      if (channel) await channel.editMessage(origin.chatId, handle, text);
    },
    newJobId,
    backgroundJob(jobId, promise, cancel, meta = {}) {
      registerJob({
        jobId,
        toolName: meta.toolName || 'unknown',
        title:    meta.title    || '(untitled)',
        cancel,
        promise,
        origin: { ...origin, displayName: 'SYSTEM' },
      });
    },
    busy: () => activeJob,
    scheduler,
    log: (...args) => { log(`[tool:${origin.channel}]`, ...args); },
  };
}

// ---------------------------------------------------------------------------
// Chat-agent turn execution
// ---------------------------------------------------------------------------

function buildSystemPrompt(memoryContext?: string): TextBlock[] {
  const base = existsSync(PROMPT_PATH) ? readFileSync(PROMPT_PATH, 'utf8') : DEFAULT_SYSTEM_PROMPT;
  const project = `\n\n## Project\nYou are operating inside the "${PROJECT_NAME}" nanogent project.`;
  const learnings = loadLearnings();
  const jobState = activeJob
    ? `\n\n## Current state\nA background job is running: "${activeJob.title}" (tool=${activeJob.toolName}, id=${activeJob.jobId}). Do not start another job of the same kind — ask the user or call check_job_status.`
    : '';
  const learnSection = learnings.trim() ? `\n\n${learnings.trim()}` : '';
  const dynamic = `${project}${learnSection}${jobState}`;
  // Cache breakpoint goes on the stable base prompt only. The dynamic core
  // block (learnings + job state) and the memory plugin's systemContext sit
  // after the breakpoint because they can change between turns.
  const blocks: TextBlock[] = [{ type: 'text', text: base, cache_control: { type: 'ephemeral' } }];
  if (dynamic) blocks.push({ type: 'text', text: dynamic });
  if (memoryContext && memoryContext.trim()) {
    blocks.push({ type: 'text', text: `\n\n## Memory\n${memoryContext.trim()}` });
  }
  return blocks;
}

/**
 * Commit new messages to the history store, then notify the memory plugin.
 * History is the source of truth; memory is a derived view. If the memory
 * index fails to update, we log and continue — it can be rebuilt from history.
 */
async function commitMessages(contactId: string, messages: HistoryMessage[]): Promise<void> {
  if (!history || !memory) throw new Error('history/memory not loaded');
  if (messages.length === 0) return;
  await history.append(contactId, messages);
  try {
    await memory.onAppend(contactId, messages);
  } catch (e) {
    log(`memory onAppend error (${contactId}):`, (e as Error)?.message || e);
  }
}

/**
 * Retract the last `count` messages from history and tell memory to
 * invalidate its index entries for them. Used by skip + error recovery.
 */
async function retractMessages(contactId: string, count: number): Promise<void> {
  if (!history || !memory) throw new Error('history/memory not loaded');
  if (count <= 0) return;
  await history.retractLast(contactId, count);
  try {
    await memory.onRetract(contactId, count);
  } catch (e) {
    log(`memory onRetract error (${contactId}):`, (e as Error)?.message || e);
  }
}

const DEFAULT_SYSTEM_PROMPT = `You are a friendly project assistant talking to a client via chat. You have access to tools for doing real work — prefer calling them over making things up. If a message is side chatter not addressed to you, call skip. User messages are always prefixed with [Name]: — use the name to address speakers and tell participants apart in group chats.`;

function toolSchemasFor(effectiveTools: string[]): ToolSchema[] {
  const arr: ToolSchema[] = effectiveTools
    .map(name => tools.get(name))
    .filter((t): t is ToolPlugin | ToolSchema => Boolean(t))
    .map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  if (arr.length > 0) {
    arr[arr.length - 1]!.cache_control = { type: 'ephemeral' };
  }
  return arr;
}

/**
 * Run one chat-agent turn for the given contact.
 * Returns the assistant text to send back (or null if skipped).
 *
 * The caller must have already committed the triggering user message via
 * commitMessages() before invoking runTurn — this way runTurn's own recall()
 * call sees it. `triggerMessageCount` is how many messages the caller
 * appended for this turn (typically 1), so skip/error paths can retract
 * them cleanly.
 */
async function runTurn(
  origin: Origin,
  effectiveTools: string[],
  triggerMessageCount: number,
  queryText: string,
): Promise<string | null> {
  if (!provider || !memory) throw new Error('provider/memory not loaded');
  const toolList = toolSchemasFor(effectiveTools);

  // Ask the memory plugin for the context to send this turn. `queryText`
  // is the plain latest user text — RAG plugins use it for relevance ranking.
  const recalled = await memory.recall(origin.contactId, queryText);
  const messages: HistoryMessage[] = recalled.messages.slice();

  let response = await provider.chat({
    model:     CHAT_MODEL,
    maxTokens: MAX_TOKENS,
    system:    buildSystemPrompt(recalled.systemContext),
    messages,
    tools:     toolList,
  });

  while (response.stopReason === 'tool_use') {
    const skipped = response.content.some(b => b.type === 'tool_use' && b.name === 'skip');
    if (skipped) {
      // Drop the triggering user message(s) — behave as if we never saw them.
      await retractMessages(origin.contactId, triggerMessageCount);
      log(`[${origin.contactId}] skip`);
      return null;
    }

    const toolResults: ContentBlock[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const toolUse = block as ToolUseBlock;
      const result = await executeTool(toolUse.name, toolUse.input || {}, origin);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    const midTurnMessages: HistoryMessage[] = [
      { role: 'assistant', content: response.content },
      { role: 'user',      content: toolResults },
    ];
    messages.push(...midTurnMessages);
    await commitMessages(origin.contactId, midTurnMessages);

    response = await provider.chat({
      model:     CHAT_MODEL,
      maxTokens: MAX_TOKENS,
      system:    buildSystemPrompt(recalled.systemContext),
      messages,
      tools:     toolList,
    });
  }

  await commitMessages(origin.contactId, [{ role: 'assistant', content: response.content }]);

  const text = response.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
  return text || null;
}

// ---------------------------------------------------------------------------
// Turn queue (per contactId — serialises per conversation, not per process)
// ---------------------------------------------------------------------------

interface Trigger {
  channel: string;
  chatId: string;
  contactId: string;
  displayName: string;
  isGuest: boolean;
  effectiveTools: string[] | null;
  text: string;
  isSystemTrigger?: boolean;
}

const turnQueue: Trigger[] = [];
let turnRunning = false;

function enqueueTurn(trigger: Trigger): void {
  turnQueue.push(trigger);
  void kickTurnWorker();
}

async function kickTurnWorker(): Promise<void> {
  if (turnRunning) return;
  turnRunning = true;
  try {
    while (turnQueue.length) {
      const trigger = turnQueue.shift();
      if (trigger) await processTrigger(trigger);
    }
  } finally {
    turnRunning = false;
  }
}

/**
 * Inject a synthetic [SYSTEM] turn into the queue. This is the single entry
 * point for non-user-initiated turns — used by the scheduler tick loop today
 * and available to any future source of time-based or event-based triggers.
 * The resulting turn goes through the same per-contact serializer, memory
 * recall, tool-use loop, and channel send pipeline as a normal user turn;
 * the only difference is the trigger text is framed as a system message
 * rather than `[Name]: ...`.
 *
 * Exported so that plugins and external callers (future webhooks, event
 * bridges) can drive the runtime without faking a user message.
 */
export function fireSystemTurn(opts: {
  channel: string;
  chatId: string;
  contactId: string;
  text: string;
}): void {
  enqueueTurn({
    channel:        opts.channel,
    chatId:         opts.chatId,
    contactId:      opts.contactId,
    displayName:    'SYSTEM',
    isGuest:        false,
    effectiveTools: null,
    text:           opts.text,
    isSystemTrigger: true,
  });
}

async function processTrigger(trigger: Trigger): Promise<void> {
  const { channel, chatId, contactId, displayName, text, effectiveTools, isSystemTrigger } = trigger;

  // For system triggers (job completion, recovery), recompute effective tools
  // from the origin chat so the chat agent has the same permissions it would
  // have had when triggered by a fresh user message.
  let perTurnTools = effectiveTools;
  if (isSystemTrigger || !perTurnTools) {
    const match = findChat(contacts, channel, chatId);
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

  const origin: Origin = { channel, chatId, contactId };

  const prefix = isSystemTrigger ? '' : `[${displayName}]: `;
  const triggerText = prefix + text;
  const triggerMessage: HistoryMessage = { role: 'user', content: triggerText };
  await commitMessages(contactId, [triggerMessage]);

  try {
    const reply = await runTurn(origin, perTurnTools, 1, triggerText);
    if (reply) {
      const ch = channels.get(channel);
      if (ch) await ch.sendMessage(chatId, reply);
    }
  } catch (e) {
    log('turn error', (e as Error)?.message || e);
    if (!isSystemTrigger) {
      const ch = channels.get(channel);
      if (ch) await ch.sendMessage(chatId, `⚠️ error: ${(e as Error)?.message || String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduler tick loop — drives the optional scheduler plugin
// ---------------------------------------------------------------------------
//
// Once a minute, ask the scheduler plugin which schedules are due, fan each
// one into fireSystemTurn, then mark it complete (or failed if enqueueing
// threw). Fire-and-forget semantics: the scheduler records "we fired this"
// on enqueue success and does not wait for the turn to actually run. Turn-
// level failures (provider errors, tool errors) are logged by processTrigger
// like any other turn, not retried by the scheduler.
//
// If no scheduler plugin is loaded, this is a no-op.

const SCHEDULER_TICK_MS = 60_000;
let schedulerTickTimer: NodeJS.Timeout | null = null;

async function schedulerTick(): Promise<void> {
  if (!scheduler) return;
  try {
    const due = await scheduler.claimDue(new Date(), 10);
    for (const job of due) {
      try {
        fireSystemTurn({
          channel:   job.schedule.channel,
          chatId:    job.schedule.chatId,
          contactId: job.schedule.contactId,
          text:      `[SCHEDULED "${job.schedule.name}"] ${job.schedule.prompt}`,
        });
        await scheduler.markComplete(job.jobId);
        log(`scheduler fired ${job.schedule.id} "${job.schedule.name}" → ${job.schedule.contactId}`);
      } catch (e) {
        const msg = (e as Error)?.message || String(e);
        try { await scheduler.markFailed(job.jobId, msg); } catch { /* ignore */ }
        log(`scheduler fire failed ${job.schedule.id}:`, msg);
      }
    }
  } catch (e) {
    log('scheduler tick error', (e as Error)?.message || e);
  }
}

function startSchedulerTick(): void {
  if (!scheduler) return;
  // Fire one tick immediately so any schedules that came due while the
  // process was down get picked up right away, subject to the scheduler
  // plugin's own missed-fire policy.
  void schedulerTick();
  schedulerTickTimer = setInterval(() => { void schedulerTick(); }, SCHEDULER_TICK_MS);
}

function stopSchedulerTick(): void {
  if (schedulerTickTimer) {
    clearInterval(schedulerTickTimer);
    schedulerTickTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Slash commands (operator shortcuts, bypass the LLM)
// ---------------------------------------------------------------------------

async function handleSlash(text: string, origin: Origin): Promise<void> {
  const ch = channels.get(origin.channel);
  if (!ch) return;
  const say = (t: string) => ch.sendMessage(origin.chatId, t);

  if (text === '/status') {
    if (!activeJob) { await say('💤 idle'); return; }
    const secs = Math.round((Date.now() - activeJob.startedAt) / 1000);
    await say(`🏃 ${activeJob.title}\n(tool=${activeJob.toolName}, id=${activeJob.jobId}, ${secs}s)`);
    return;
  }
  if (text === '/cancel') {
    if (!activeJob) { await say('nothing to cancel'); return; }
    try { activeJob.cancel?.(); } catch { /* ignore */ }
    await say(`🛑 cancel requested (${activeJob.jobId})`);
    return;
  }
  if (text === '/clear') {
    if (activeJob) { await say('⚠️ a job is running — /cancel first, then /clear'); return; }
    if (history) await history.clear(origin.contactId);
    if (memory) {
      try { await memory.onClear(origin.contactId); }
      catch (e) { log('memory onClear error', (e as Error)?.message || e); }
    }
    await say('✨ history cleared — next message starts fresh');
    return;
  }
  if (text === '/help' || text === '/start') {
    await say([
      `Hi — send me any message and I will help with the "${PROJECT_NAME}" project.`,
      '',
      'Operator shortcuts:',
      '/status — current job',
      '/cancel — cancel running job',
      '/clear  — wipe chat history',
      '/help   — this message',
    ].join('\n'));
    return;
  }
  await say('unknown command. try /status /cancel /clear /help');
}

// ---------------------------------------------------------------------------
// Channel plugin ctx — passed to each channel's start()
// ---------------------------------------------------------------------------

function makeChannelCtx(channelName: string): ChannelCtx {
  return {
    projectName: PROJECT_NAME,

    /**
     * Look up a chat by (channel, chatId). Returns the chat config object
     * (including mode, historyMode, etc.) or null if unknown.
     */
    getChatConfig(channel, chatId) {
      const match = findChat(contacts, channel, chatId);
      return match ? match.chat : null;
    },

    /**
     * Called by the channel plugin when a message is ready to hand off to
     * the core. The plugin has already done any mode-based filtering.
     */
    onMessage(msg) {
      handleIncomingMessage(msg);
    },

    log: (...args) => { log(`[channel:${channelName}]`, ...args); },
  };
}

function handleIncomingMessage(msg: IncomingMessage): void {
  const { channel, chatId, user, text } = msg;
  const trimmed = (text || '').trim();
  if (!trimmed) return;

  // Resolve access (allowlist + permission).
  const access = resolveAccess(contacts, [...tools.keys()], { channel, chatId, user });
  if (!access.allowed) {
    log(`drop [${access.reason}] channel=${channel} chatId=${chatId} user=${user.id} name="${user.displayName || ''}" preview="${trimmed.slice(0, 60)}"`);
    return;
  }

  const origin: Origin = {
    channel,
    chatId,
    contactId: access.contactId,
  };

  // Slash commands bypass the chat agent entirely.
  if (trimmed.startsWith('/')) {
    void handleSlash(trimmed, origin);
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

const channelStopFns: Array<() => void> = [];

async function main(): Promise<void> {
  bootstrap();
  await loadAllPlugins();
  await recoverInterruptedJob();

  for (const [name, channel] of channels) {
    try {
      const stop = await channel.start(makeChannelCtx(name));
      if (typeof stop === 'function') channelStopFns.push(stop);
    } catch (e) {
      log(`channel ${name}: start failed —`, (e as Error)?.message || e);
    }
  }

  if (!provider) {
    die('provider not loaded');
    return;
  }

  startSchedulerTick();

  log(`listening: project="${PROJECT_NAME}" model=${CHAT_MODEL} channels=[${[...channels.keys()].join(',')}] tools=[${[...tools.keys()].join(',')}] provider=${provider.name}${scheduler ? ` scheduler=${scheduler.name}` : ''}`);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function shutdown(): void {
  log('bye');
  stopSchedulerTick();
  for (const stop of channelStopFns) {
    try { stop(); } catch { /* ignore */ }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  console.log(`[nanogent project=${PROJECT_NAME}]`, ...args);
}

function die(msg: string): void {
  console.error(`[nanogent] ${msg}`);
  process.exit(1);
}

export function loadEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i < 0) continue;
    out[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function loadConfig(path: string): Config {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')) as Config; }
  catch (e) { console.error(`[nanogent] warning: failed to parse ${path}: ${(e as Error)?.message || e}`); return {}; }
}

export function loadContacts(path: string): Contacts {
  if (!existsSync(path)) return { alwaysAllowed: ['skip'], users: {}, chats: {} };
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as Partial<Contacts>;
    return {
      alwaysAllowed: c.alwaysAllowed || ['skip'],
      users:         c.users || {},
      chats:         c.chats || {},
    };
  } catch (e) {
    console.error(`[nanogent] warning: failed to parse ${path}: ${(e as Error)?.message || e}`);
    return { alwaysAllowed: ['skip'], users: {}, chats: {} };
  }
}

// ---------------------------------------------------------------------------
// Only run main() when this file is executed directly (not when imported from
// tests). Uses argv[1] comparison against import.meta.url.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch(e => { console.error('[nanogent] fatal', e); process.exit(1); });
}
