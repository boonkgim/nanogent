// memory/naive — default memory plugin for nanogent.
//
// "Naive" = no vectors, no graphs, no summarisation. Just reads the last N
// messages from the history store and returns them, applying boundary-aware
// rotation so we never hand the LLM an orphan tool_result.
//
// For anything smarter (RAG, GraphRAG, mem0-style episodic memory, summary
// memories), write a new plugin under .nanogent/memory/<name>/ and swap this
// out.
//
// This file is also where the old v0.4.x `rotateHistory` / `isTurnStart`
// helpers moved to — they're a memory concern, not a storage concern. The
// history store (see .nanogent/history/) is pure append-only and never
// rotates.

import type {
  ContentBlock, HistoryMessage, HistoryStorePlugin, MemoryCtx, MemoryPlugin, RecallResult,
} from '../../types.d.ts';

// ---------------------------------------------------------------------------
// Boundary-aware windowing — exported for tests
// ---------------------------------------------------------------------------

export function isTurnStart(message: HistoryMessage): boolean {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') return true;
  if (!Array.isArray(message.content)) return false;
  return !message.content.some((b: ContentBlock) => b?.type === 'tool_result');
}

/**
 * Return the most recent `window` messages, but never leave an orphan
 * tool_result at the head (which would make the Anthropic API reject the
 * request). Scans forward from the naive cut point to the next turn-start;
 * if none found, returns an empty array.
 */
export function rotateHistory(h: HistoryMessage[], window: number): HistoryMessage[] {
  if (h.length <= window) return h;
  const minStart = h.length - window;
  for (let i = minStart; i < h.length; i++) {
    const msg = h[i];
    if (msg && isTurnStart(msg)) return h.slice(i);
  }
  for (let i = h.length - 1; i >= 0; i--) {
    const msg = h[i];
    if (msg && isTurnStart(msg)) return h.slice(i);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

let history: HistoryStorePlugin | null = null;
let windowSize = 80;

const plugin: MemoryPlugin = {
  name: 'naive',

  async init(ctx: MemoryCtx): Promise<void> {
    history = ctx.history;
    const envWindow = Number(process.env.NANOGENT_MEMORY_WINDOW);
    if (!Number.isNaN(envWindow) && envWindow > 0) windowSize = envWindow;
  },

  async recall(contactId: string, _query: string): Promise<RecallResult> {
    if (!history) throw new Error('memory/naive: init() was not called');
    // Pull a buffer slightly larger than the window so boundary-aware
    // rotation has room to walk forward to the next turn-start.
    const raw = await history.read(contactId, { limit: windowSize * 2 });
    const messages = rotateHistory(raw, windowSize);
    return { messages };
  },

  async onAppend(_contactId: string, _messages: HistoryMessage[]): Promise<void> {
    // Naive memory has no index to maintain — history is the index.
  },

  async onRetract(_contactId: string, _count: number): Promise<void> {
    // Nothing to invalidate.
  },

  async onClear(_contactId: string): Promise<void> {
    // Nothing to clear — the history store owns the bytes.
  },
};

export default plugin;
