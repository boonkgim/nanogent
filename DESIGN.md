# nanogent — design decisions

This document captures the **design decisions** behind nanogent's architecture. It's written for **contributors** and **future plugin authors** (tools, channels, providers), not end users. For user-facing documentation, see [README.md](README.md).

The goal is to preserve the reasoning behind nanogent's shape so future work doesn't accidentally undo intentional choices. If a decision changes, update this document **before** the code.

For the high-level design *principles* — the "what nanogent is" character — see [README.md § Design principles](README.md#design-principles). Those principles explain the flavour of the project; this document explains the *consequences* of those principles as specific technical choices.

## Scope

This document is **normative**. If you're writing a channel plugin, a tool, a provider, or extending the core, the decisions below are the rules.

Versions referenced:
- **v0.3.x** — Tools as drop-in folders; Telegram and Anthropic hardcoded in the core runtime.
- **v0.4.0** — Channels and providers extracted into plugin directories. Permission model via `contacts.json`. Multi-channel, single-provider.
- **v0.4.x → v0.5.0** — Runtime converted to TypeScript (single hand-written `.ts` file, Node 24+ type stripping).
- **v0.5.0** — History and memory extracted into separate plugin directories. History store is the raw append-only log; memory is the indexer/retriever. Both are exactly-one-active. See [DR-009a](#dr-009a-history-storage-is-a-separate-pluggable-raw-log-concern) and [DR-009b](#dr-009b-memory-is-a-separate-pluggable-indexerretriever-over-history).

## Architecture at a glance

```
.nanogent/
  nanogent.ts         — core runtime
  prompt.md           — system prompt template
  config.json         — non-secret config (projectName, chatModel, docker, ...)
  contacts.json       — chat allowlist + user mapping + permissions  [v0.4.0+]
  types.d.ts          — plugin contracts (shared, shipped via `init`)
  .env / .env.example — secrets (gitignored via .nanogent/.gitignore)
  .gitignore          — hides .env and /state/
  state/              — core runtime state (jobs, learnings; history lives under its plugin)
  tools/<name>/       — plugin tools (many active)                    [v0.3.1+]
  channels/<name>/    — plugin channels (many active)                 [v0.4.0]
  providers/<name>/   — plugin AI providers (exactly one active)      [v0.4.0]
  history/<name>/     — plugin history store  (exactly one active)    [v0.5.0]
  memory/<name>/      — plugin memory system  (exactly one active)    [v0.5.0]
```

Five plugin directories, five extensibility points:

| Plugin type | Directory | How many active? | What it does | Status |
|---|---|---|---|---|
| **Tool** | `tools/<name>/` | Many | Exposes a capability to the chat agent (`claude`, `rag`, `search`, ...) | Implemented (v0.3.1) |
| **Channel** | `channels/<name>/` | Many | Handles a transport (`telegram`, `whatsapp`, `email`, ...) | Implemented (v0.4.0) |
| **Provider** | `providers/<name>/` | Exactly one | Implements the AI chat loop (`anthropic`, `openai`, ...) | Implemented (v0.4.0) |
| **History store** | `history/<name>/` | Exactly one | Raw append-only message log (`jsonl`, `postgres`, ...) | Implemented (v0.5.0) |
| **Memory** | `memory/<name>/` | Exactly one | Indexer + retriever over history (`naive`, `vector-rag`, `graphrag`, ...) | Implemented (v0.5.0) |

The asymmetry in "how many active" reflects real differences:
- **Tools are capabilities** — a project can have several (coding, RAG, search, calendar)
- **Channels are ingress points** — a project can have several (DM via Telegram, email, group on WhatsApp)
- **Providers are thinking layers** — a chat agent has one reasoning model per turn; multiplexing two providers within one conversation is confused, not a feature
- **History is the source of truth** — one canonical log per install; multiple stores would split the truth
- **Memory is a single lens** — the agent reasons from one context model at a time; two memories would disagree on what's relevant

## Core data model (v0.4.0)

### Message — normalised shape every channel plugin produces

```js
{
  channel:  'telegram',
  chatId:   '-1001234567890',
  user: {
    id:          '12345',           // platform-native stable ID
    displayName: 'Alice',           // human-readable; falls back to user:<id>
  },
  text:     'make the header darker',
  isGroup:  true,                   // hint for the core, set by the plugin
}
```

- `channel` — plugin name, unique per install
- `chatId` — **opaque to the core**; plugin-defined (see [DR-001](#dr-001-chatid-granularity-is-a-plugin-decision))
- `user.id` — stable platform-native identifier (Telegram `from.id`, WhatsApp JID, email from-address, Discord snowflake, etc.)
- `user.displayName` — optional human name from the platform or overridden via `contacts.json`
- `text` — message body
- `isGroup` — multi-participant chat hint, set by the plugin

### History

Stored under `.nanogent/state/history/`. Filename layout depends on the chat's `historyMode` (see [DR-002](#dr-002-historymode--shared-vs-per-user)):

```
shared:    .nanogent/state/history/<chatId-sanitized>.jsonl
per-user:  .nanogent/state/history/<chatId-sanitized>/<userId-sanitized>.jsonl
```

The `-sanitized` suffix means a path-safe encoding of the raw value — channel plugins may emit chatIds with characters that aren't legal in filenames. A simple `encodeURIComponent` or hex encoding is sufficient.

User messages appended to history are **always prefixed** with `[displayName]: ` (see [DR-003](#dr-003-user-messages-are-always-prefixed-with-displayname)).

### contacts.json — the access control + identity file

```json
{
  "alwaysAllowed": ["skip"],

  "users": {
    "alice":    { "displayName": "Alice",    "tools": ["claude", "learn"] },
    "bob":      { "displayName": "Bob",      "tools": ["claude"] },
    "operator": { "displayName": "Operator", "tools": ["claude", "learn", "cancel_job"] }
  },

  "chats": {
    "alice-dm-tg": {
      "channel":     "telegram",
      "chatId":      "12345",
      "displayName": "Alice (Telegram DM)",
      "userMapping": { "12345": "alice" },
      "userTools":   ["claude", "learn"],
      "allowGuests": false,
      "historyMode": "shared",
      "mode":        "always",
      "enabled":     true
    },
    "project-group-tg": {
      "channel":     "telegram",
      "chatId":      "-1001234567890",
      "displayName": "Project Alpha Group",
      "userMapping": { "12345": "alice", "67890": "bob" },
      "userTools":   ["claude"],
      "allowGuests": false,
      "historyMode": "shared",
      "mode":        "mention",
      "enabled":     true
    },
    "public-helpdesk-email": {
      "channel":     "email",
      "chatId":      "*",
      "displayName": "Public Helpdesk",
      "userMapping": {},
      "userTools":   [],
      "guestTools":  ["search_faq"],
      "allowGuests": true,
      "historyMode": "per-user",
      "mode":        "always",
      "enabled":     true
    }
  }
}
```

Fields:

- `alwaysAllowed` — tools union-added to every effective tool set. Default `["skip"]`.
- `users.<name>` — username-keyed definitions with `displayName` and `tools`.
- `chats.<key>` — chat entries keyed by an operator-chosen label.
  - `channel`, `chatId` — identify the chat (chatId may be `"*"` for a wildcard)
  - `userMapping` — maps raw platform user IDs to usernames from the `users` section
  - `userTools` — chat-level restriction intersected with user-level tools
  - `guestTools` — tools granted to unknown users in this chat (when `allowGuests: true`)
  - `allowGuests` — whether unknown users are processed or silent-dropped
  - `historyMode` — `shared` | `per-user`
  - `mode` — `always` | `mention`
  - `enabled` — optional, default `true`; set `false` to pause a chat without deleting the entry

### Effective permission computation

For a known user:

```
effective = alwaysAllowed ∪ (user.tools ∩ chat.userTools) ∩ installedTools
```

For an unknown user in a chat where `allowGuests: true`:

```
effective = alwaysAllowed ∪ chat.guestTools ∩ installedTools
```

For an unknown user in a chat where `allowGuests: false` → silent drop + log (no LLM call).

See [DR-005](#dr-005-permission-model--chat--user-intersection-no-tool-level-permissions).

---

## Decision records

Each decision below is numbered sequentially and structured as **What / Why / Consequences**. When adding a new one, append it and keep the numbering.

### DR-001: chatId granularity is a plugin decision

**What.** The `chatId` field on messages is **opaque to the core**. The core never inspects, parses, or interprets it beyond using it as a dictionary key for history and permission lookups. Each channel plugin chooses its own strategy for mapping real-world conversations to chatIds.

**Why.** Different channels have fundamentally different conversation shapes:

| Channel | Natural chatId strategy | Why |
|---|---|---|
| Telegram DM | `from.id` | Stable, unique per user |
| Telegram group | `chat.id` (negative) | One conversation shared by all group members |
| Discord channel | channel ID | Same as Telegram groups |
| Discord DM | DM channel ID | Stable per user |
| WhatsApp DM | JID (phone number) | Stable identity |
| WhatsApp group | group JID | Shared group thread |
| Email 1:1 | sender address, OR per-thread ID | Either works; per-thread is more general (see [DR-004](#dr-004-email-channel-should-use-per-thread-chatids-with-shared-history)) |
| Email multi-recipient | thread ID (via `In-Reply-To`/`References`) | Only per-thread handles group-shaped email correctly |
| Slack | channel ID | Natural |

Forcing a uniform chatId rule in the core would either:
- Lose channel-native semantics (e.g., collapsing email threads into per-sender conversations loses multi-recipient handling)
- Leak channel-specific logic into the core (e.g., the core parsing RFC 5322 threading headers)

Leaving the decision to the plugin keeps the core simple and lets each plugin express its platform's natural conversation shape.

**Consequences.**
- Channel plugin authors **must document their chatId strategy** in the plugin's `README.md`
- Entries in `contacts.json` reference chatIds in the plugin's chosen format
- Wildcard chatIds (`"*"`) work across all strategies because they're just "match any value in this channel"
- Migration between strategies within a plugin (e.g., upgrading an email plugin from per-sender to per-thread) requires a history migration — the core doesn't provide one, but plugin authors should document the migration path if they change strategies

### DR-002: historyMode — shared vs per-user

**What.** Each chat entry in `contacts.json` has a `historyMode` field with two valid values:

- **`"shared"`** — history keyed by `chatId` alone. All users in the chat see the same conversation history. Right for: Telegram DMs, Telegram groups, Discord channels, Slack channels, email threads (when the plugin uses per-thread chatIds), 1:1 email (if the plugin uses per-sender chatIds).
- **`"per-user"`** — history keyed by `(chatId, userId)`. Each user has their own private history within this chat. Right for: email with chatId = bot's own inbox (so all senders share one chatId but each needs a private history), wildcard chats where many unrelated senders appear under one matching entry.

**Why.** There are two fundamentally different conversation shapes in chat platforms:

- **Shared-thread**: Multiple participants, one common thread visible to all. Group chats, channels. History is genuinely shared among participants — that's the defining feature of a group.
- **Multiplexed**: Multiple participants, each thinking they're having a private 1:1 conversation with the bot, unaware of other participants. Public inboxes, helpdesks, bulk email. History **must** be per-user to preserve privacy — Alice shouldn't see Bob's conversation just because they both emailed the same address.

A single keying scheme can't handle both correctly. The `historyMode` field lets operators and plugin authors choose per chat.

**Defaults by situation.**

| Situation | Default `historyMode` | Rationale |
|---|---|---|
| DM (single-user chat) | `shared` | Only one user — shared and per-user are equivalent |
| Group (multi-user shared thread) | `shared` | That's what a group IS |
| Wildcard (`chatId: "*"`) | `per-user` | Multiplexed-by-default is the safer assumption |
| Email with per-thread chatIds | `shared` | Threads are naturally shared — plugin should recommend this default |
| Email with per-inbox chatId (not recommended; see [DR-004](#dr-004-email-channel-should-use-per-thread-chatids-with-shared-history)) | `per-user` | Required for privacy if the chatId doesn't separate senders |

Operators can override any default.

**Consequences.**
- History filenames branch based on `historyMode`
- Permission and allowlist logic is unaffected — those are `chatId`-only concerns
- Migration between modes requires file restructuring (not automatic)
- Channel plugin docs should recommend a default for their platform

### DR-003: User messages are always prefixed with `[displayName]:`

**What.** Every user turn in history is stored with the sender's display name prefixed to the text, in the format `[Alice]: actual message text`. This applies uniformly across **all chats, all modes, all contexts** — DMs, groups, shared, per-user, 1:1, multiplexed. When `displayName` is not set, the prefix falls back to `[user:<raw-id>]:`.

**Why.** Uniformity. Alternative designs were considered:

- **Conditional prefix** (only in multi-user shared chats): two code paths, two system-prompt rules, weird edge cases when a chat migrates between modes or when a user's `displayName` is updated, non-uniform LLM context across chats
- **No prefix** (strip sender info): loses attribution, fails in groups, the LLM can't tell speakers apart

Always-prefix has real but negligible costs (5-10 extra tokens per turn in a 1:1 DM at Haiku rates — rounding error). Benefits dominate: single code path, uniform system-prompt rule, consistent LLM experience regardless of chat type.

**Consequences.**
- The default system prompt template includes: *"User messages are always prefixed with `[Name]:`. Use the name to address speakers and tell participants apart in group chats."*
- Channel plugins don't handle prefixing themselves — the core does it when appending to history
- Display name lookups use a precedence chain:
  1. `contacts.json > users[username].displayName`
  2. Channel plugin's provided `user.displayName`
  3. Fallback to `user:<raw-id>`

### DR-004: Email channel should use per-thread chatIds with shared history

**What.** Future email channel plugin implementers **should default to per-thread chatIds**. Derive `chatId` from the email's `In-Reply-To` or `References` header chain, falling back to the `Message-ID` for new threads. Each thread is its own chatId; `historyMode` is `shared`; all participants in the thread see the same history.

**Why.** Email is unusual: it supports both 1:1 and group semantics depending on CC/BCC/To headers within the **same inbox**. A plugin has to handle both.

Four candidate strategies were considered:

1. **Per-sender chatId** (simple): `chatId = from_address`. Trivial to implement. Only handles 1:1 email; multi-recipient emails are either reply-to-sender-only or dropped. Loses thread context for group-shaped email.

2. **Per-thread chatId** (recommended): `chatId` derived from email threading headers (`In-Reply-To`, `References`, falling back to `Message-ID`). Handles both 1:1 (single-participant thread) AND multi-recipient (shared group thread). Moderate plugin complexity (need RFC 5322 threading logic, well-understood and has libraries).

3. **Per-participant-set chatId**: `chatId = hash(sorted(participants))`. Handles groups but fragments history if participants change mid-thread (Alice adds Bob to a CC list, history splits).

4. **Per-inbox chatId** (chatId = bot's own address, one static value for all incoming mail): requires `historyMode: per-user` to preserve privacy between senders. Works for 1:1 but **breaks multi-recipient threads** — Bob's reply-all lands in Bob's per-user history, losing Alice's earlier context from the thread.

Per-thread is the cleanest shape for email because it matches how humans experience email: a thread is a conversation, whether it has two participants or twenty. 1:1 email just happens to be a thread with one non-bot participant — no special-casing needed.

**Consequences.**
- An email plugin following this guidance must parse RFC 5322 threading headers (`Message-ID`, `In-Reply-To`, `References`) and normalize to a stable thread ID
- `contacts.json` entries reference email chats by thread ID or use wildcards (`"*"`) for "any email thread"
- Multi-recipient threads have multiple users; `userMapping` can list known senders by from-address
- Reply-all behaviour is the email plugin's concern: when the bot responds, it should include all thread participants except the bot itself
- **SPF/DKIM verification is the plugin's concern.** `From:` headers are trivially spoofable; before trusting a from-address for permission checks, the plugin must verify SPF alignment, DKIM signature, or both. An un-verified sender should be treated as a guest (or silent-dropped) regardless of whether the from-address is in `userMapping`.
- Plugin authors are free to choose a different strategy, but this document recommends per-thread — and if you pick something else, you should document why in your plugin's README.

### DR-005: Permission model — chat + user intersection, no tool-level permissions

**What.** Tool permissions are declared in `contacts.json`, **never** inside tool source files. Tools never export `requiredRole`, `allowedRoles`, or similar fields. The core's permission check intersects three sources:

1. **Global `alwaysAllowed`** (in contacts.json) — default `["skip"]`
2. **User-level `tools`** (in `users[username].tools`)
3. **Chat-level `userTools`** (in `chats[chatKey].userTools`)

Effective tool set for a known user:

```
effective = alwaysAllowed ∪ (user.tools ∩ chat.userTools) ∩ installedTools
```

For guests (when `allowGuests: true`):

```
effective = alwaysAllowed ∪ chat.guestTools ∩ installedTools
```

**Why.** Two alternatives were considered and rejected:

1. **Tool-level declarations** (`allowedRoles: ['admin']` on the tool export). Rejected because:
   - Spreads the security surface across many files
   - Couples tool code to permission taxonomies
   - Forces tool authors to reason about roles they shouldn't care about
   - Operators can't retune permissions without editing tool source files
   - Breaks the "tools are standalone" design principle

2. **Role hierarchies** (admin > client > guest with inheritance). Rejected because:
   - Adds complexity for a rarely-needed feature
   - "Why can't Alice do X?" debugging becomes reasoning about role interactions
   - Flat allowlists are simpler to audit and easier to reason about

Centralising permissions in `contacts.json` gives operators one place to change policy and keeps tool code permission-agnostic.

**Consequences.**
- Tool authors never declare permissions — just a name, description, input schema, and execute function
- Operators have a **single source of truth** for "who can do what"
- The core filters the per-turn tool schema based on the current caller — tools the caller can't invoke are **invisible to the LLM**, not just rejected at call time (cleaner UX, saves reasoning tokens on paths the LLM can't take)
- If operators need permission tiers beyond what intersection supports (e.g., Alice has a different `claude` implementation than Bob), they run **separate nanogent installs** with different tools — honouring the decentralised principle

### DR-006: Cross-channel identity is operator-managed, not LLM-inferred

**What.** Linking two chatIds (or two platform user IDs) to the same user across different channels is done by the **operator** via `contacts.json`, not by the chat agent via an LLM tool. There is **no `link_contact` tool** in the core for v0.4.0.

**Why.** Identity linking is a privacy-critical operation. If an LLM decides to merge two users based on conversational cues, it risks:

- **Impersonation via assertion**: attacker messages the bot claiming to be another user ("Hi, I'm Alice, this is my new Telegram ID")
- **Context clue mis-matches** leading to wrong merges that expose one user's private history to another
- **Irrecoverable cross-contamination** — once histories are merged in error, separating them is hard

LLMs have no way to authenticate identity assertions. Linking must be **out-of-band** — the operator knows, from real-world context, that these two chatIds both belong to Alice.

**Consequences.**
- `contacts.json` operators use the single `users` section plus per-chat `userMapping` entries to bind raw platform IDs to usernames
- There is no CLI tool, core tool, or runtime API that lets the LLM modify contact bindings
- A future convenience might add an **admin-gated** `link_contact` CLI command (or runtime tool), but never as an LLM-invokable action available to untrusted users
- Operators who want cross-channel merging run one of:
  - Maintain `contacts.json` by hand
  - Use a future (v0.4.x+) CLI helper
  - Accept that channels remain separate per-project (the current default)

### DR-007: Unknown chats get silent drop + log

**What.** When a message arrives from a `(channel, chatId)` pair that is not matched by any entry in `contacts.json` (and no wildcard matches), the core:

- Logs one line containing `channel`, `chatId`, the sender's display name if available, and a truncated preview of the message text
- **Takes no other action**: no LLM call, no history entry, no response sent, no tokens consumed

**Why.** Alternatives were considered:

- **Respond with a "you are not authorised" message**: leaks the bot's existence to strangers, burns tokens on every probe, invites reconnaissance attacks
- **Auto-create a guest contact**: implicitly widens the allowlist, defeats the purpose of having one
- **Accept and queue for operator review**: adds unbounded state growth and attack surface

Silent drop with observability (a single log line per attempt) is the default-deny answer. Operators can grep logs to see who's attempting to contact the bot and decide whether to allowlist them.

**Consequences.**
- The bot is **invisible** to anyone not explicitly allowed — no reconnaissance surface
- Adding a new user requires an explicit, out-of-band action by the operator (edit `contacts.json`, or use a future CLI helper)
- Logs become an important operator workflow — the README should document how operators review dropped-contact logs
- Legitimate users who aren't yet allowlisted get no feedback; they have to reach the operator via another channel. This is an acceptable friction cost for safety-by-default.

### DR-008: Group chats require per-chat `mode` field for mention filtering

**What.** Each chat entry in `contacts.json` has a `mode` field with two valid values:

- **`"always"`** — bot processes every message in the chat
- **`"mention"`** — bot only processes messages that mention the bot (`@bot_name`) OR are replies to the bot's own messages

Defaults by chat type:

- DMs → `always`
- Groups → `mention`
- Wildcard chats → `always` (wildcards imply open channels where every message is a new conversation)

**Why.** In a busy group chat, most messages are human-to-human conversation irrelevant to the bot. Processing every message burns tokens on `skip` decisions and clutters the conversation with bot responses to things that weren't addressed to it.

Mention filtering is standard bot etiquette on Telegram, Discord, and Slack. The `mode` field lets operators override the default — some small teams prefer a bot that listens to everything in a project group without requiring `@`-mentions each time.

**Consequences.**
- Channel plugins are responsible for implementing both modes using their platform's native primitives — Telegram plugins check `message.entities` for mentions and `message.reply_to_message.from.id` for replies; Discord plugins check mentions arrays; etc.
- A plugin on a platform that doesn't have native "mention" semantics (e.g., email) only supports `always` mode — the plugin should ignore `mode: mention` or log a warning
- The core itself doesn't enforce `mode`; it's a contract between operator config and channel plugin behaviour

### DR-009a: History storage is a separate, pluggable, raw-log concern

**What.** History is stored by a dedicated **history store plugin** under `.nanogent/history/<name>/`. Exactly one history store is active per install. The history store is an **append-only raw log** — it stores messages exactly as they were produced and returns them verbatim. It does **not** rotate, summarise, filter, or re-rank. The default plugin (`history/jsonl`) writes one JSONL file per `contactId`; alternative implementations can back history with a relational DB, a KV store, an object store, etc.

The contract is deliberately minimal:

```ts
interface HistoryStorePlugin {
  init(ctx): Promise<void>;
  append(contactId, messages): Promise<void>;
  read(contactId, opts?: { limit? }): Promise<HistoryMessage[]>;
  retractLast(contactId, count): Promise<void>;
  clear(contactId): Promise<void>;
}
```

The core owns `contactId` computation ([DR-002](#dr-002-historymode--shared-vs-per-user)) and treats the string as opaque to the plugin. Message shape is the canonical `HistoryMessage` from `types.d.ts` — role + content, where content is either a string or an array of Anthropic-shaped content blocks (text / tool_use / tool_result).

**Why.** Two separate plugin points (history + memory) instead of one unified "memory" plugin, because storage and retrieval are genuinely different concerns:

- **Storage wants**: durability, portable format, predictable write cost, auditability, reindexability.
- **Retrieval wants**: relevance ranking, context budgeting, cross-turn synthesis, RAG/graph/summary variants.

Bundling them would force every memory plugin to also solve storage (rewrite JSONL to vector DB, re-implement crash-safe writes, handle file locking, etc.) and would make memory swaps destroy prior conversations. Separating them gives:

1. **Reindex on demand.** Drop the memory index, replay `append` from history, rebuild. Not possible if memory owns storage.
2. **Memory swap without data loss.** Try vector RAG today, GraphRAG next month — raw conversations survive the swap.
3. **Portable audit trail.** Operators can `cat` the JSONL regardless of which memory system is active.
4. **Trivial unit tests.** Feed a fixture history into any memory plugin, assert recall output.

**Consequences.**
- The core never reads or writes history files directly — every access goes through `history.append / read / retractLast / clear`.
- Rotation, windowing, and "last N messages" logic do **not** belong in the history store. They are retrieval concerns and live in the memory plugin. History grows forever by default; operator archival/pruning is a separate concern a future plugin can add.
- `contactId` computation stays in core ([DR-002](#dr-002-historymode--shared-vs-per-user)) — the privacy boundary between shared and per-user histories is a security decision, not a storage decision.
- **Failure mode**: if `history.append` fails, the core aborts the turn and does not call `memory.onAppend`. History is the source of truth — memory is always recoverable from history, never the other way around.
- Bundled memory systems (mem0, Letta, MemGPT) that own their own storage can ship alongside a no-op history plugin, but the default recommendation is to keep the JSONL history as an audit trail even then — one write per turn is cheap.
- `history.retractLast(n)` is the contract for undoing the last N appended messages (used by `skip` and error recovery). The core tracks how many it appended in a turn; plugins just honour the count.
- **Migration from v0.4.x**: existing `.nanogent/state/history/*.jsonl` files are read unchanged by `history/jsonl` — the on-disk format didn't change, only the location of the code that reads/writes it.

### DR-009b: Memory is a separate pluggable indexer/retriever over history

**What.** A **memory plugin** under `.nanogent/memory/<name>/` is the system that decides what context to surface for the next turn. Exactly one memory plugin is active per install. The memory plugin receives `onAppend` notifications for every new message and returns a `RecallResult` at turn start:

```ts
interface MemoryPlugin {
  init(ctx: { history: HistoryStorePlugin, ... }): Promise<void>;
  recall(contactId, query): Promise<{ messages: HistoryMessage[]; systemContext?: string }>;
  onAppend(contactId, messages): Promise<void>;
  onRetract(contactId, count): Promise<void>;
  onClear(contactId): Promise<void>;
}
```

The default plugin (`memory/naive`) reads the last N messages from the history store, applies boundary-aware rotation, and returns them with no `systemContext`. It maintains no index of its own — history *is* the index.

Smarter memory plugins (vector RAG, GraphRAG, summarisation, mem0-style episodic memory, entity extraction) build their own index in `onAppend`, and in `recall` return a short recent window of raw messages plus an optional `systemContext` string containing retrieved context, running summaries, extracted facts, or whatever the retrieval strategy produces.

**Why.** Memory is an active research area — vector RAG, GraphRAG, summarisation, agentic retrieval, episodic/semantic splits, tiered archival like MemGPT. Hardcoding any one of them into the core would either freeze the project on a design that's outdated within a year, or force every user to inherit complexity they don't need. Making memory a plugin point lets the core stay dumb and lets the ecosystem move.

Three design decisions worth calling out:

1. **Recall returns both `messages` AND `systemContext`.** Forcing everything into `messages` corrupts the conversation shape (a summary as a fake assistant turn? fake user turn?). A separate `systemContext` slot lets plugins inject retrieved excerpts, summaries, or entity facts as system-prompt text while keeping the message array semantically clean.

2. **Memory receives the history store via ctx injection.** Memory plugins can read history directly (`ctx.history.read(contactId)`) for bootstrap/reindex/fallback behaviour. They don't need to maintain a shadow copy.

3. **Memory owns rotation and windowing.** The old v0.4.x `rotateHistory` / `MAX_HISTORY` logic moved into `memory/naive/index.ts`. This unlocked a real simplification: the history store no longer pretends to be a "recent window" — it's an append-only log, full stop. RAG memories don't rotate at all.

**Consequences.**
- The core's per-turn loop is: `memory.recall → provider.chat → commit new messages via history.append + memory.onAppend → loop if tool_use`. Only the memory plugin decides what the LLM sees.
- **`systemContext` and prompt caching**: Anthropic prompt caching invalidates on any change to the system prompt bytes before the cache breakpoint. The core places `systemContext` *after* the cached base prompt so a volatile memory context doesn't nuke the cache on every turn. Plugin authors who return long `systemContext` strings should still structure them with a stable prefix followed by the volatile part.
- **Failure mode**: if `memory.onAppend` or `memory.onRetract` fails, the core logs and continues. The memory index can always be rebuilt from history, so an out-of-sync index is a soft failure, not a data-loss event. This recoverability only exists because history is a separate plugin.
- **Cross-turn consistency**: memory plugins see every message the core commits, including assistant turns, tool uses, tool results, and `[SYSTEM]` notices. Plugins that embed text for retrieval should filter content blocks appropriately.
- **`/clear` semantics**: `/clear` calls both `history.clear(contactId)` and `memory.onClear(contactId)`. A memory plugin that persists across `/clear` (e.g. a long-term entity store) should ignore `onClear` or handle it as a soft signal — but the default is to wipe.
- **Query for relevance ranking**: `recall(contactId, query)` passes the plain latest user text. RAG plugins use it; naive memory ignores it. Plugins should not assume `query` is the full turn context — it's just the trigger text.
- **Not a cache**: memory is a retrieval system, not a cache of history. Two memory plugins can coexist during migration by running both and comparing, but only one is ever active in production (exactly-one rule).

---

## Guidance for plugin authors

### Writing a channel plugin

Read [DR-001](#dr-001-chatid-granularity-is-a-plugin-decision), [DR-002](#dr-002-historymode--shared-vs-per-user), and [DR-008](#dr-008-group-chats-require-per-chat-mode-field-for-mention-filtering) first — these are the decisions most likely to affect your design.

**Checklist:**

- [ ] Pick a `chatId` strategy that matches your platform's native conversation shape (see [DR-001](#dr-001-chatid-granularity-is-a-plugin-decision))
- [ ] Document your `chatId` strategy in your plugin's `README.md`
- [ ] Emit `user.id` and `user.displayName` when the platform provides them
- [ ] Implement both `mode: always` and `mode: mention` if your platform supports mentions; otherwise document that only `always` works
- [ ] Verify sender authenticity when the platform makes that possible (SPF/DKIM for email, signed payloads for webhooks, etc.)
- [ ] Respect the contacts.json allowlist by checking it before forwarding messages to the core — the core will drop unknown chats, but your plugin can short-circuit to save work
- [ ] Keep plugin state under `<plugin-dir>/state/` and ship a `.gitignore` listing `state/` if that state is per-machine/transient
- [ ] If you're writing an email plugin, follow [DR-004](#dr-004-email-channel-should-use-per-thread-chatids-with-shared-history)

### Writing a tool plugin

See [README.md § Adding a tool](README.md#adding-a-tool) for the current (v0.3.x) guidance. Key points:

- Tools are drop-in folders with a required `index.mjs`
- Default-export `{ name, description, input_schema, execute(input, ctx) }`
- **No permission declarations** on the tool itself — see [DR-005](#dr-005-permission-model--chat--user-intersection-no-tool-level-permissions)
- Tools only import from node stdlib and talk to `ctx`
- Long-running tools return `{ async: true, jobId }` immediately and register a background promise via `ctx.backgroundJob(...)`
- State goes in `<tool-dir>/state/`; ship a `.gitignore` if you want it hidden

### Writing a provider plugin (v0.4.0+)

Providers implement the AI chat loop used by nanogent's chat agent. Plugin authors should:

- Implement a single `chat({ system, messages, tools, model, maxTokens })` function returning a normalised `{ stopReason, content, usage }` shape
- Accept Anthropic-shaped `messages` and `tools` as input (the core's canonical shape) and map internally to your provider's native format
- Honour `cache_control` markers in `system` and `tools` if your provider supports caching; ignore them otherwise (log a debug line noting they were present)
- Don't try to multiplex multiple backends at the core level — if you want fallback (Anthropic → OpenAI on error), wrap both backends **inside a single plugin** that handles fallback internally. The core sees one provider.

### Writing a history store plugin (v0.5.0+)

Read [DR-009a](#dr-009a-history-storage-is-a-separate-pluggable-raw-log-concern) first.

**Checklist:**

- [ ] Implement the full `HistoryStorePlugin` contract: `init`, `append`, `read`, `retractLast`, `clear`
- [ ] `append` is the hot path — keep it fast; batch writes if your backend has per-call overhead
- [ ] `read(contactId, { limit })` should honour the `limit` hint by returning at most that many of the **most recent** messages (tail, not head)
- [ ] `retractLast(contactId, count)` must be exact — the core tracks how many messages it committed in a turn and expects to undo them precisely
- [ ] Treat `contactId` as opaque — the core computes it and owns the privacy semantics
- [ ] Never rotate, summarise, or filter. Windowing is the memory plugin's job.
- [ ] Keep plugin-local state (locks, indices, etc.) under `<plugin-dir>/state/` and ship a `.gitignore`

### Writing a memory plugin (v0.5.0+)

Read [DR-009b](#dr-009b-memory-is-a-separate-pluggable-indexerretriever-over-history) first.

**Checklist:**

- [ ] Implement the full `MemoryPlugin` contract: `init`, `recall`, `onAppend`, `onRetract`, `onClear`
- [ ] Use `ctx.history` for bootstrap/reindex — never maintain a shadow copy of raw messages
- [ ] `recall` returns `{ messages, systemContext? }` — keep `messages` in valid Anthropic shape (no orphan `tool_result` at head)
- [ ] If you inject dynamic text via `systemContext`, structure it as `stable prefix + volatile suffix` to preserve prompt caching
- [ ] `onAppend` runs on every committed message (including assistant turns, tool_use, tool_result, `[SYSTEM]` notes) — filter the ones you care about
- [ ] `onRetract` must be reversible with `onAppend` — if you embedded messages, remove their embeddings
- [ ] `onClear` should wipe per-contact state; long-term stores that persist across `/clear` should document that deviation
- [ ] Log errors but don't throw — the core treats memory failures as recoverable (index can always be rebuilt from history)
- [ ] Keep plugin-local state under `<plugin-dir>/state/` and namespace by `contactId`

### Email plugin — specific guidance

See [DR-004](#dr-004-email-channel-should-use-per-thread-chatids-with-shared-history). Quick summary:

- **`chatId = thread ID`** derived from RFC 5322 threading headers (`In-Reply-To`, `References`, `Message-ID`)
- **`historyMode = shared`** (threads are naturally shared among participants)
- **`mode = always`** (no native mention concept)
- **Reply-all** by including all thread participants except the bot
- **Verify SPF/DKIM** before trusting `From:` for permission lookups
- **Wildcard chatIds** (`"*"`) are fine for a "public helpdesk" pattern — every new thread gets its own chatId and its own history
- **Document your threading logic** in your plugin's README for operators who need to troubleshoot

---

## Out of scope / deferred

These are capabilities we've discussed and deliberately deferred. They may land in later versions if concrete use cases drive them.

- **Cross-channel identity resolution** — Alice on Telegram = Alice on WhatsApp. Deferred; operators manage identity via `contacts.json` manually for now.
- **Admin-convenience `link_contact` CLI command** — operators edit `contacts.json` directly in v0.4.0. A CLI wrapper is a candidate for v0.4.x.
- **Hot-reload of `contacts.json`** — file-watch or mtime-check for on-the-fly updates. Probably v0.4.1.
- **Per-(user, chat) role hierarchies** — use separate nanogent installs for different trust tiers. If the separate-install pattern proves insufficient, revisit.
- **Per-user learnings scoping** — learnings are currently global. Per-contact scoping might come later if prompt-injection-via-learning becomes a real problem. (Note: once v0.5.0 memory plugins land, per-contact scoping is most naturally implemented as a memory plugin that treats learnings as structured context rather than as a core change.)
- **Provider-level fallback as a core feature** — handled inside a single provider plugin, not core. Waiting for a concrete use case.
- **Tool-level audit logging** — structured audit trail beyond log greps. Not until someone asks.
- **Dynamic runtime permission updates** without restart — low priority; requires hot-reload plumbing.
- **Rate limiting per (user, tool)** — tools can implement their own if needed. No core feature planned.
- **Structured identity federation** across multiple nanogent installs (Alice's DM history + Alice's group history merged across installs) — deliberately out of scope; each install is autonomous.

---

## Revision history

- **0.1 (2026-04-14)** — Initial draft capturing decisions from the v0.4.0 design discussion. Channels and providers as plugins; permission model via `contacts.json`; email guidance; historyMode semantics.
- **0.2 (2026-04-14)** — Added DR-009a (history storage is a separate pluggable raw log) and DR-009b (memory is a separate pluggable indexer/retriever). Captures the v0.5.0 split of history and memory into two exactly-one-active plugin directories, the recall/append/retractLast/clear contract, `systemContext` in `RecallResult`, cache-control placement guidance, and the "history is source of truth, memory is recoverable" consistency model.

When adding a new decision or updating an existing one, add a line here with the date and a one-sentence summary.
