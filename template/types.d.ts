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
  docker?: boolean;
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
