// Unit tests for the pure helpers exported from template/nanogent.ts.
// These functions are the three-layer permission model (DR-007), the
// boundary-aware history rotation (DR-004), and the .env parser.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findChat, resolveAccess, rotateHistory, isTurnStart, sanitize, unique,
  loadEnv, loadConfig, loadContacts,
} from '../template/nanogent.ts';
import type { Contacts, HistoryMessage } from '../template/types.d.ts';

// ---------------------------------------------------------------------------
// findChat
// ---------------------------------------------------------------------------

describe('findChat', () => {
  const contacts: Contacts = {
    alwaysAllowed: ['skip'],
    users: {},
    chats: {
      'alice_dm': { channel: 'telegram', chatId: '111', userTools: ['claude'] },
      'public_group': { channel: 'telegram', chatId: '-999', mode: 'mention' },
      'any_email': { channel: 'email', chatId: '*', allowGuests: true },
    },
  };

  it('returns exact (channel, chatId) match', () => {
    const found = findChat(contacts, 'telegram', '111');
    assert.equal(found?.key, 'alice_dm');
  });

  it('returns null for unknown chat', () => {
    assert.equal(findChat(contacts, 'telegram', '404'), null);
  });

  it('falls back to wildcard chatId for a channel when no exact match', () => {
    const found = findChat(contacts, 'email', 'random@x.com');
    assert.equal(found?.key, 'any_email');
  });

  it('prefers exact match over wildcard', () => {
    const withBoth: Contacts = {
      ...contacts,
      chats: {
        ...contacts.chats,
        'specific_email': { channel: 'email', chatId: 'vip@x.com' },
      },
    };
    const found = findChat(withBoth, 'email', 'vip@x.com');
    assert.equal(found?.key, 'specific_email');
  });

  it('does not match across channels', () => {
    assert.equal(findChat(contacts, 'whatsapp', '111'), null);
  });
});

// ---------------------------------------------------------------------------
// resolveAccess (the three-layer permission model)
// ---------------------------------------------------------------------------

describe('resolveAccess', () => {
  const installed = ['skip', 'check_job_status', 'cancel_job', 'learn', 'claude', 'rag'];

  const baseContacts: Contacts = {
    alwaysAllowed: ['skip', 'check_job_status'],
    users: {
      alice: { displayName: 'Alice', tools: ['claude', 'rag', 'learn'] },
      bob:   { displayName: 'Bob',   tools: ['claude'] },
    },
    chats: {
      alice_dm: {
        channel: 'telegram', chatId: '111',
        userMapping: { '1001': 'alice' },
      },
      shared_group: {
        channel: 'telegram', chatId: '-999',
        userMapping: { '1001': 'alice', '1002': 'bob' },
        userTools: ['claude', 'learn'],
      },
      guest_email: {
        channel: 'email', chatId: '*',
        allowGuests: true,
        guestTools: ['rag'],
      },
      disabled: {
        channel: 'telegram', chatId: '222', enabled: false,
        userMapping: { '1001': 'alice' },
      },
    },
  };

  it('drops unknown chat', () => {
    const r = resolveAccess(baseContacts, installed, {
      channel: 'telegram', chatId: 'nope', user: { id: '1001' },
    });
    assert.equal(r.allowed, false);
    assert.equal((r as { reason: string }).reason, 'unknown-chat');
  });

  it('drops disabled chat', () => {
    const r = resolveAccess(baseContacts, installed, {
      channel: 'telegram', chatId: '222', user: { id: '1001' },
    });
    assert.equal(r.allowed, false);
    assert.equal((r as { reason: string }).reason, 'chat-disabled');
  });

  it('drops unknown user in chat without guests', () => {
    const r = resolveAccess(baseContacts, installed, {
      channel: 'telegram', chatId: '111', user: { id: '9999' },
    });
    assert.equal(r.allowed, false);
    assert.equal((r as { reason: string }).reason, 'unknown-user-no-guests');
  });

  it('grants known user full tool set in DM (no chat.userTools filter)', () => {
    const r = resolveAccess(baseContacts, installed, {
      channel: 'telegram', chatId: '111', user: { id: '1001' },
    });
    assert.equal(r.allowed, true);
    if (!r.allowed) return;
    // alwaysAllowed ∪ user.tools, intersected with installed
    assert.deepEqual(
      [...r.effectiveTools].sort(),
      ['check_job_status', 'claude', 'learn', 'rag', 'skip'],
    );
    assert.equal(r.displayName, 'Alice');
    assert.equal(r.isGuest, false);
  });

  it('intersects user.tools with chat.userTools in group', () => {
    const r = resolveAccess(baseContacts, installed, {
      channel: 'telegram', chatId: '-999', user: { id: '1001' },
    });
    assert.equal(r.allowed, true);
    if (!r.allowed) return;
    // alice has [claude, rag, learn]; group allows [claude, learn]
    // => intersection = [claude, learn]
    // + alwaysAllowed = [skip, check_job_status]
    assert.deepEqual(
      [...r.effectiveTools].sort(),
      ['check_job_status', 'claude', 'learn', 'skip'],
    );
  });

  it('bob with only [claude] in group [claude, learn] → [claude]', () => {
    const r = resolveAccess(baseContacts, installed, {
      channel: 'telegram', chatId: '-999', user: { id: '1002' },
    });
    assert.equal(r.allowed, true);
    if (!r.allowed) return;
    assert.deepEqual(
      [...r.effectiveTools].sort(),
      ['check_job_status', 'claude', 'skip'],
    );
  });

  it('filters out tools not installed', () => {
    const thin = ['skip', 'claude']; // no check_job_status, no rag
    const r = resolveAccess(baseContacts, thin, {
      channel: 'telegram', chatId: '111', user: { id: '1001' },
    });
    assert.equal(r.allowed, true);
    if (!r.allowed) return;
    assert.deepEqual([...r.effectiveTools].sort(), ['claude', 'skip']);
  });

  it('guest in wildcard chat gets guestTools + alwaysAllowed', () => {
    const r = resolveAccess(baseContacts, installed, {
      channel: 'email', chatId: 'stranger@x.com', user: { id: 'stranger@x.com', displayName: 'Stranger' },
    });
    assert.equal(r.allowed, true);
    if (!r.allowed) return;
    assert.equal(r.isGuest, true);
    assert.deepEqual(
      [...r.effectiveTools].sort(),
      ['check_job_status', 'rag', 'skip'],
    );
    // Wildcard chats default historyMode to per-user → contactId has a user suffix
    assert.match(r.contactId, /^guest_email\//);
  });

  it('non-wildcard chats default historyMode to shared', () => {
    const r = resolveAccess(baseContacts, installed, {
      channel: 'telegram', chatId: '-999', user: { id: '1001' },
    });
    assert.equal(r.allowed, true);
    if (!r.allowed) return;
    assert.equal(r.contactId, 'shared_group');
    assert.equal(r.historyMode, 'shared');
  });
});

// ---------------------------------------------------------------------------
// rotateHistory (boundary-aware truncation)
// ---------------------------------------------------------------------------

describe('rotateHistory', () => {
  const userText = (text: string): HistoryMessage => ({ role: 'user', content: text });
  const assistantText = (text: string): HistoryMessage => ({ role: 'assistant', content: text });
  const toolResult = (): HistoryMessage => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
  });

  it('returns input unchanged when under limit', () => {
    const h = [userText('a'), assistantText('b')];
    assert.deepEqual(rotateHistory(h, 10), h);
  });

  it('trims oldest turns when over limit', () => {
    const h = [
      userText('t1'), assistantText('r1'),
      userText('t2'), assistantText('r2'),
      userText('t3'), assistantText('r3'),
    ];
    const result = rotateHistory(h, 4);
    assert.equal(result.length, 4);
    assert.equal((result[0] as HistoryMessage).content, 't2');
  });

  it('never leaves an orphan tool_result at head', () => {
    // History: [user-turn, assistant-tool-use, tool-result, assistant-text]
    // With maxHistory=2, the naive slice would leave [tool_result, assistant]
    // which is malformed. rotateHistory must scan forward to next turn-start.
    const h = [
      userText('start'),
      assistantText('mid'),
      toolResult(),
      assistantText('end'),
      userText('next'),
      assistantText('reply'),
    ];
    const result = rotateHistory(h, 3);
    // Must start on a user-turn-start (text, not tool_result)
    const first = result[0];
    assert.ok(first);
    assert.ok(isTurnStart(first), 'first message must be a turn-start');
  });

  it('returns empty array if no turn-start found within window', () => {
    // Edge case: history is pathologically all tool_results (shouldn't happen
    // in practice, but we check the fallback)
    const h = [toolResult(), toolResult(), toolResult()];
    const result = rotateHistory(h, 1);
    assert.deepEqual(result, []);
  });
});

// ---------------------------------------------------------------------------
// isTurnStart
// ---------------------------------------------------------------------------

describe('isTurnStart', () => {
  it('plain user string is a turn start', () => {
    assert.equal(isTurnStart({ role: 'user', content: 'hi' }), true);
  });

  it('assistant messages are never turn starts', () => {
    assert.equal(isTurnStart({ role: 'assistant', content: 'hi' }), false);
  });

  it('user message containing tool_result is not a turn start', () => {
    assert.equal(isTurnStart({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
    }), false);
  });
});

// ---------------------------------------------------------------------------
// sanitize + unique
// ---------------------------------------------------------------------------

describe('sanitize', () => {
  it('replaces unsafe characters with underscores', () => {
    assert.equal(sanitize('hello@world.com'), 'hello_world.com');
    assert.equal(sanitize('a/b/c'), 'a_b_c');
  });
  it('preserves allowed characters', () => {
    assert.equal(sanitize('abc_123-XYZ.foo'), 'abc_123-XYZ.foo');
  });
});

describe('unique', () => {
  it('dedupes preserving first occurrence order', () => {
    assert.deepEqual(unique([1, 2, 1, 3, 2]), [1, 2, 3]);
    assert.deepEqual(unique(['a', 'b', 'a']), ['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// loadEnv / loadConfig / loadContacts (against a tempdir)
// ---------------------------------------------------------------------------

describe('loadEnv', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nanogent-env-'));
  const envPath = join(tmp, '.env');
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns empty object when file missing', () => {
    assert.deepEqual(loadEnv(join(tmp, 'nope')), {});
  });

  it('parses key=value pairs', () => {
    writeFileSync(envPath, 'FOO=bar\nBAZ=qux\n');
    assert.deepEqual(loadEnv(envPath), { FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comments and blank lines', () => {
    writeFileSync(envPath, '# a comment\n\nA=1\n# another\nB=2\n');
    assert.deepEqual(loadEnv(envPath), { A: '1', B: '2' });
  });

  it('strips surrounding quotes from values', () => {
    writeFileSync(envPath, 'A="quoted"\nB=\'also\'\nC=plain\n');
    assert.deepEqual(loadEnv(envPath), { A: 'quoted', B: 'also', C: 'plain' });
  });

  it('preserves equals signs in values', () => {
    writeFileSync(envPath, 'TOKEN=abc=def=ghi\n');
    assert.deepEqual(loadEnv(envPath), { TOKEN: 'abc=def=ghi' });
  });
});

describe('loadConfig', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nanogent-config-'));
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns empty object if missing', () => {
    assert.deepEqual(loadConfig(join(tmp, 'nope.json')), {});
  });

  it('parses a valid config', () => {
    const p = join(tmp, 'config.json');
    writeFileSync(p, JSON.stringify({ projectName: 'demo', maxTokens: 2048 }));
    assert.deepEqual(loadConfig(p), { projectName: 'demo', maxTokens: 2048 });
  });

  it('returns empty object on parse error (does not throw)', () => {
    const p = join(tmp, 'bad.json');
    writeFileSync(p, '{not json');
    assert.deepEqual(loadConfig(p), {});
  });
});

describe('loadContacts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'nanogent-contacts-'));
  after(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns skeleton when missing', () => {
    const r = loadContacts(join(tmp, 'nope.json'));
    assert.deepEqual(r, { alwaysAllowed: ['skip'], users: {}, chats: {} });
  });

  it('populates defaults for missing top-level keys', () => {
    const p = join(tmp, 'partial.json');
    writeFileSync(p, JSON.stringify({ users: { a: {} } }));
    const r = loadContacts(p);
    assert.deepEqual(r.alwaysAllowed, ['skip']);
    assert.deepEqual(r.users, { a: {} });
    assert.deepEqual(r.chats, {});
  });
});
