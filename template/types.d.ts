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
  log(...args: unknown[]): void;
}

export interface ToolResult {
  async?: boolean;
  jobId?: string;
  content?: string;
}

// Tool lifecycle context — passed to ToolPlugin.start() once at boot. A tool
// that needs a background loop (timers, watchers, pollers) owns it inside
// start() and returns a stop fn for clean shutdown. Core provides primitives
// (`fireSystemTurn` to inject non-user turns, `pluginDir` for self-owned
// state, `history` for tools that want to read or index the append log) and
// never reaches into the tool's folder. See DESIGN.md DR-014.
export interface ToolStartCtx {
  projectName: string;
  projectDir: string;
  pluginDir: string;               // the tool's own folder — put runtime data under pluginDir/state/
  history: HistoryStorePlugin;     // handle for tools that maintain derived indexes (RAG, summary, etc.)
  fireSystemTurn(opts: {
    channel: string;
    chatId: string;
    contactId: string;
    text: string;
  }): void;
  log(...args: unknown[]): void;
}

// Per-turn context for ToolPlugin.contributeContext() — the hook that lets
// any tool inject an extra system-prompt text block into the next provider
// call without being invoked by the LLM. Used by RAG/summary/clock/location
// tools that want to push context into the turn reactively. See DESIGN.md
// DR-016.
//
// The injection surface is text only: tools return a string that core
// appends after the base system prompt. Tools MUST NOT attempt to mutate
// the messages array — that is core's correctness invariant (the history
// store owns it, boundary-aware rotation keeps it valid).
export interface ToolContextCtx {
  projectName: string;
  contactId: string;
  channel: string;
  chatId: string;
  query: string;                                   // latest user text — useful for RAG relevance ranking
  messages: ReadonlyArray<HistoryMessage>;         // the current window the LLM will see this turn (read-only)
  log(...args: unknown[]): void;
}

export interface ToolPlugin {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute(input: Record<string, any>, ctx: ToolCtx): Promise<ToolResult | string>;
  // Optional lifecycle hook for tools that hold state or run background
  // loops. Called once after all tools are loaded. Return a stop fn (or
  // void) — core calls it during shutdown. Failures inside start() are
  // logged but do not block boot.
  start?(ctx: ToolStartCtx): Promise<(() => void) | void>;
  // Optional per-turn hook — called once before provider.chat() on every
  // turn. Return a text block to inject into the system prompt, or null to
  // skip this turn. Failures are logged and the tool's contribution is
  // skipped — the turn proceeds. See DESIGN.md DR-016.
  contributeContext?(ctx: ToolContextCtx): Promise<string | null>;
  // Optional history-lifecycle hooks — called after the named operation
  // commits against the history store. Tools that maintain derived state
  // (vector indexes, summaries) use these to stay in sync. Failures are
  // logged but do not block the turn.
  onHistoryAppended?(contactId: string, messages: HistoryMessage[]): Promise<void>;
  onHistoryRetracted?(contactId: string, count: number): Promise<void>;
  onClear?(contactId: string): Promise<void>;
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
  pluginDir: string;               // the plugin's own folder — put runtime data under pluginDir/state/
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
// Context injection — how tools surface extra system-prompt text per turn
// ---------------------------------------------------------------------------
//
// There is no "memory plugin" type. Core always windows raw history via
// boundary-aware rotation; any tool that wants to push additional context
// into the next turn (RAG retrievers, summary recall, clock, location,
// status pollers) implements the optional `contributeContext()` hook on
// ToolPlugin above. Smarter retrievers maintain their own index via the
// optional onHistoryAppended/onHistoryRetracted/onClear hooks.
//
// See DESIGN.md DR-016 for the rationale and DR-014 for the coupling
// principle this enforces.

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
