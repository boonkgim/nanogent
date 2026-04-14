// Shared plugin contract types for nanogent core + plugins.
//
// This file is type-only (.d.ts). Node's type stripper never sees it at
// runtime — all `import type` statements referencing it are erased. It ships
// to users via `nanogent init` so their hand-written plugins can typecheck.

// ---------------------------------------------------------------------------
// Anthropic-canonical message / content shapes used by core + providers
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: 'ephemeral' };
}

export interface ProviderChatArgs {
  model: string;
  maxTokens: number;
  system: TextBlock[];
  messages: HistoryMessage[];
  tools: ToolSchema[];
}

export interface ProviderChatResult {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | string;
  content: ContentBlock[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}

// ---------------------------------------------------------------------------
// Tool plugin contract
// ---------------------------------------------------------------------------

export interface ActiveJob {
  jobId: string;
  toolName: string;
  title: string;
  startedAt: number;
}

export interface ToolCtx {
  projectName: string;
  projectDir: string;
  toolDir: string;
  channel: string;
  chatId: string;
  contactId: string;
  sendMessage(text: string): Promise<MessageHandle | null>;
  editMessage(handle: MessageHandle | null, text: string): Promise<void>;
  newJobId(): string;
  backgroundJob(
    jobId: string,
    promise: Promise<unknown>,
    cancel: () => void,
    meta?: { toolName?: string; title?: string },
  ): void;
  busy(): ActiveJob | null;
  // Scheduler plugin handle, if one is loaded. The bundled `schedule` tool
  // talks to the agent's stored schedules through this. Null if no scheduler
  // is installed — tools that need scheduling should surface a clear error.
  scheduler: SchedulerPlugin | null;
  log(...args: unknown[]): void;
}

export interface ToolResult {
  async?: boolean;
  jobId?: string;
  content?: string;
}

export interface ToolPlugin {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute(input: Record<string, any>, ctx: ToolCtx): Promise<ToolResult | string>;
}

// ---------------------------------------------------------------------------
// Channel plugin contract
// ---------------------------------------------------------------------------

export interface MessageHandle {
  messageId: number;
}

export interface IncomingMessage {
  channel: string;
  chatId: string;
  user: {
    id: string;
    displayName?: string;
  };
  text: string;
  isGroup?: boolean;
}

export interface ChannelCtx {
  projectName: string;
  getChatConfig(channel: string, chatId: string): ChatEntry | null;
  onMessage(msg: IncomingMessage): void;
  log(...args: unknown[]): void;
}

export interface ChannelPlugin {
  name: string;
  start(ctx: ChannelCtx): Promise<(() => void) | void>;
  sendMessage(chatId: string, text: string): Promise<MessageHandle | null>;
  editMessage(chatId: string, handle: MessageHandle | null, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider plugin contract
// ---------------------------------------------------------------------------

export interface ProviderPlugin {
  name: string;
  chat(args: ProviderChatArgs): Promise<ProviderChatResult>;
}

// ---------------------------------------------------------------------------
// History store plugin contract — raw append-only message log
// ---------------------------------------------------------------------------
//
// A history store is the canonical, append-only record of what was said.
// It knows nothing about relevance, windowing, or retrieval — it just stores
// bytes and gives them back. Memory plugins sit on top and decide what
// subset to surface to the LLM.
//
// Exactly one history store is active per install. See DESIGN.md DR-009a.

export interface HistoryStoreCtx {
  projectName: string;
  projectDir: string;
  stateDir: string;                // .nanogent/state (plugin should namespace under its own subdir)
  pluginDir: string;               // the plugin's own folder on disk
  log(...args: unknown[]): void;
}

export interface HistoryStorePlugin {
  name: string;
  init(ctx: HistoryStoreCtx): Promise<void>;
  append(contactId: string, messages: HistoryMessage[]): Promise<void>;
  read(contactId: string, opts?: { limit?: number }): Promise<HistoryMessage[]>;
  retractLast(contactId: string, count: number): Promise<void>;
  clear(contactId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Memory plugin contract — indexer + retriever over history
// ---------------------------------------------------------------------------
//
// A memory plugin decides what context to surface for the next turn. Naive
// implementations just return the last N messages from the history store.
// Smarter ones (vector RAG, GraphRAG, summarisation, mem0-style) build their
// own index off the `onAppend` callback and return a filtered subset plus
// optional `systemContext` text injected into the system prompt.
//
// Exactly one memory plugin is active per install. See DESIGN.md DR-009b.

export interface MemoryCtx {
  projectName: string;
  projectDir: string;
  stateDir: string;                // .nanogent/state (plugin should namespace under its own subdir)
  pluginDir: string;
  history: HistoryStorePlugin;     // injected — memory plugins read history via this handle
  log(...args: unknown[]): void;
}

export interface RecallResult {
  messages: HistoryMessage[];      // goes into provider.chat({ messages })
  systemContext?: string;          // optional extra text appended to the system prompt
}

export interface MemoryPlugin {
  name: string;
  init(ctx: MemoryCtx): Promise<void>;
  // Called at turn start. `query` is the latest user text (useful for RAG relevance ranking).
  recall(contactId: string, query: string): Promise<RecallResult>;
  // Called whenever new messages are appended to history. Index them if you want.
  onAppend(contactId: string, messages: HistoryMessage[]): Promise<void>;
  // Called when the last N appended messages are being retracted (skip / error recovery).
  onRetract(contactId: string, count: number): Promise<void>;
  // Called by /clear.
  onClear(contactId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Scheduler plugin contract — time-based proactive triggers
// ---------------------------------------------------------------------------
//
// A scheduler plugin owns BOTH schedule definitions (rules the agent set up)
// AND the execution log (what actually fired, when, with what status). Core
// ticks the scheduler once a minute and hands each due job to the existing
// system-turn entry point (see fireSystemTurn in nanogent.ts), which routes
// the synthetic trigger back to the origin channel + chat.
//
// Zero or one scheduler is active per install (unlike history/memory which
// are required). If no scheduler is loaded, scheduling features silently
// degrade — the tool plugin returns a clear error, the tick loop is a no-op.
//
// See DESIGN.md DR-010.

export interface SchedulerCtx {
  projectName: string;
  projectDir: string;
  stateDir: string;                // .nanogent/state (plugin should namespace under its own subdir)
  pluginDir: string;
  log(...args: unknown[]): void;
}

// Operator-provided input when the agent calls schedule_create.
// `schedule` string format is plugin-defined; the bundled jsonl default
// accepts: "once@<ISO-UTC>", "daily@HH:MM" (UTC), "every@<seconds>".
export interface ScheduleSpec {
  name: string;                    // human-readable label ("morning briefing")
  schedule: string;                // when to fire — format depends on plugin
  prompt: string;                  // what the agent should do when it fires
  channel: string;                 // delivery route — filled in from the triggering turn
  chatId: string;                  // delivery route
  contactId: string;               // delivery route
}

// A stored schedule definition — spec + immutable metadata.
export interface Schedule extends ScheduleSpec {
  id: string;
  createdAt: string;               // ISO timestamp
}

// Returned by claimDue — a due schedule wrapped with a per-fire jobId.
// The plugin has already marked this as "in-flight" in its internal log
// before returning it; core must call markComplete or markFailed.
export interface ClaimedJob {
  jobId: string;                   // unique per fire attempt
  schedule: Schedule;              // full resolved definition
  firedAt: string;                 // ISO of the time the schedule was due
}

// One execution record. Scheduler plugins expose the log for introspection
// so the agent (or an operator tool) can answer "did my morning briefing
// actually fire yesterday?".
export interface ScheduleExecution {
  firedAt: string;
  scheduleId: string;
  jobId: string;
  status: 'claimed' | 'completed' | 'failed';
  error?: string;
}

export interface SchedulerPlugin {
  name: string;
  init(ctx: SchedulerCtx): Promise<void>;

  // Definition CRUD — called by the agent-facing `schedule` tool plugin.
  createSchedule(spec: ScheduleSpec): Promise<Schedule>;
  listSchedules(filter?: { contactId?: string }): Promise<Schedule[]>;
  getSchedule(id: string): Promise<Schedule | null>;
  deleteSchedule(id: string): Promise<boolean>;

  // Execution — called by the core tick loop.
  // claimDue MUST atomically mark returned jobs as in-flight so a second
  // claimDue call (or a second process) doesn't re-fire the same schedule.
  // The bundled jsonl default achieves this via a 'claimed' log entry.
  claimDue(now: Date, limit?: number): Promise<ClaimedJob[]>;
  markComplete(jobId: string): Promise<void>;
  markFailed(jobId: string, error: string): Promise<void>;

  // Introspection — agent/operator read-only access to execution history.
  listExecutions(filter?: { scheduleId?: string; limit?: number }): Promise<ScheduleExecution[]>;
}

// ---------------------------------------------------------------------------
// contacts.json shape
// ---------------------------------------------------------------------------

export interface UserEntry {
  displayName?: string;
  tools?: string[];
}

export interface ChatEntry {
  channel: string;
  chatId: string;
  enabled?: boolean;
  mode?: 'always' | 'mention';
  historyMode?: 'shared' | 'per-user';
  userMapping?: Record<string, string>;
  userTools?: string[];
  allowGuests?: boolean;
  guestTools?: string[];
}

export interface Contacts {
  alwaysAllowed: string[];
  users: Record<string, UserEntry>;
  chats: Record<string, ChatEntry>;
}

export interface Config {
  projectName?: string;
  chatModel?: string;
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Access resolution result (pure function output)
// ---------------------------------------------------------------------------

export type AccessDecision =
  | {
      allowed: true;
      chatKey: string;
      chat: ChatEntry;
      username: string | undefined;
      displayName: string;
      isGuest: boolean;
      contactId: string;
      effectiveTools: string[];
      historyMode: 'shared' | 'per-user';
    }
  | {
      allowed: false;
      reason: 'unknown-chat' | 'chat-disabled' | 'unknown-user-no-guests';
      chatKey?: string;
    };
