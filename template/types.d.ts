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
  maxHistory?: number;
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
