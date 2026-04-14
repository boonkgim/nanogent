// history/jsonl — default history store for nanogent.
//
// Append-only JSONL files, one per contactId, under the plugin's own
// `state/` subdir (.nanogent/history/jsonl/state/). Per DR-014, plugins
// own their state location; the plugin dir's gitignore hides it from the
// operator's repo.
//
// This plugin is **dumb on purpose**. It does not rotate, summarise, or
// filter — it's the raw log. Windowing, relevance, and retrieval are the
// memory plugin's job (see .nanogent/memory/).

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type {
  HistoryMessage, HistoryStoreCtx, HistoryStorePlugin,
} from '../../types.d.ts';

let historyDir = '';
let log: (...args: unknown[]) => void = () => {};
const cache = new Map<string, HistoryMessage[]>();

function pathFor(contactId: string): string {
  return join(historyDir, `${contactId.replace(/\//g, '__')}.jsonl`);
}

function loadFromDisk(contactId: string): HistoryMessage[] {
  const cached = cache.get(contactId);
  if (cached) return cached;
  const p = pathFor(contactId);
  let h: HistoryMessage[] = [];
  if (existsSync(p)) {
    try {
      h = readFileSync(p, 'utf8')
        .split('\n').filter(Boolean)
        .map(l => JSON.parse(l) as HistoryMessage);
    } catch (e) {
      log('history load error', contactId, (e as Error)?.message || e);
    }
  }
  cache.set(contactId, h);
  return h;
}

function serialize(messages: HistoryMessage[]): string {
  return messages.map(m => JSON.stringify(m)).join('\n') + '\n';
}

// Full rewrite — only used by retractLast/clear, where we actually need to
// drop bytes from the file. Never called from the append hot path.
function rewriteOnDisk(contactId: string): void {
  const h = cache.get(contactId) || [];
  const p = pathFor(contactId);
  if (h.length === 0) {
    try { unlinkSync(p); } catch { /* ignore */ }
    return;
  }
  writeFileSync(p, serialize(h));
}

const plugin: HistoryStorePlugin = {
  name: 'jsonl',

  async init(ctx: HistoryStoreCtx): Promise<void> {
    historyDir = join(ctx.pluginDir, 'state');
    log = ctx.log;
    mkdirSync(historyDir, { recursive: true });
  },

  async append(contactId: string, messages: HistoryMessage[]): Promise<void> {
    if (messages.length === 0) return;
    // Keep the in-memory cache warm so subsequent reads are O(1), and write
    // ONLY the new lines to disk — never rewrite the full file. With rotation
    // moved into the memory plugin, histories grow without bound; a full
    // rewrite on every turn would be O(n) in total history size.
    const h = loadFromDisk(contactId);
    h.push(...messages);
    cache.set(contactId, h);
    appendFileSync(pathFor(contactId), serialize(messages));
  },

  async read(contactId: string, opts?: { limit?: number }): Promise<HistoryMessage[]> {
    const h = loadFromDisk(contactId);
    if (opts?.limit && opts.limit > 0 && h.length > opts.limit) {
      return h.slice(-opts.limit);
    }
    // Return a shallow copy so callers can't mutate our cache.
    return h.slice();
  },

  async retractLast(contactId: string, count: number): Promise<void> {
    if (count <= 0) return;
    const h = loadFromDisk(contactId);
    if (count >= h.length) {
      cache.set(contactId, []);
      rewriteOnDisk(contactId);
      return;
    }
    h.splice(h.length - count, count);
    cache.set(contactId, h);
    rewriteOnDisk(contactId);
  },

  async clear(contactId: string): Promise<void> {
    cache.set(contactId, []);
    try { unlinkSync(pathFor(contactId)); } catch { /* ignore */ }
  },
};

export default plugin;
