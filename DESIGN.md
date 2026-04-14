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
- **v0.7.0** — Scheduler introduced as an optional (zero-or-one) plugin type. Time-based proactive triggers become a first-class concern: the agent manages schedules conversationally via the bundled `schedule` tool, a core tick loop fires due schedules through the shared `fireSystemTurn` entry point, and execution state is stored as an append-only log separate from the rules file. **This shape was reversed in v0.11.0 — see [DR-010](#dr-010-proactive-triggers-live-inside-tool-plugins-via-the-lifecycle-hook).**
- **v0.8.0** — Container dependencies made pluggable. The core `Dockerfile` becomes a base stub with a marker line; each plugin can ship an optional `install.sh` next to its `index.ts`, and a new `nanogent build` CLI command composes the real `Dockerfile.generated` by splicing every plugin's install step into the base. The `@anthropic-ai/claude-code` install moves out of core and into `tools/claude/install.sh` — swapping in a different coding harness (e.g. `tools/opencode/`) no longer requires editing the core Dockerfile. See [DR-011](#dr-011-plugins-inject-container-dependencies-via-installsh).
- **v0.9.0** — Docker becomes the only supported runtime. The host-node path, the `--node` / `--docker` start flags, and the `docker` field in `config.json` are removed. Rationale: plugin `install.sh` scripts can run `apt-get`, `npm install -g`, and write to system paths, so running them on the host is exactly the pollution Docker was added to prevent. Making Docker mandatory eliminates a dual-install contract (host vs container) and collapses the test matrix to one runtime. See [DR-012](#dr-012-docker-is-the-only-supported-runtime).
- **v0.11.0** — Core↔plugin coupling tightened: the typed `SchedulerPlugin` seam is removed, the scheduler collapses into a self-contained `tools/schedule` that owns CRUD, tick loop, and state under its own plugin directory. `ToolPlugin` gains an optional lifecycle hook (`start(ctx)` returning an optional stop fn); `ToolStartCtx` hands the plugin `pluginDir` + a `fireSystemTurn` primitive. `HistoryStoreCtx` and `MemoryCtx` drop their `stateDir` field — plugins now write state under `pluginDir/state/`, matching the convention `tools/claude` already used. Two new principles land: [DR-014](#dr-014-minimal-core-plugin-coupling) (core provides primitives, plugins own implementation details) and [DR-015](#dr-015-portable-state-via-per-type-data-contracts) (each plugin type defines a canonical `Portable<T>` envelope so alternative backends can migrate data between themselves). DR-010 is rewritten as a reversal of the v0.7.0 scheduler-plugin design.

## Architecture at a glance

```
.nanogent/
  nanogent.ts         — core runtime
  prompt.md           — system prompt template
  config.json         — non-secret config (projectName, chatModel, maxTokens)
  contacts.json       — chat allowlist + user mapping + permissions  [v0.4.0+]
  types.d.ts          — plugin contracts (shared, shipped via `init`)
  .env / .env.example — secrets (gitignored via .nanogent/.gitignore)
  .gitignore          — hides .env and /state/
  state/              — core-owned runtime state only (jobs.json, learnings.md). Per DR-014, plugins own their state under their plugin dirs, not here.
  tools/<name>/       — plugin tools (many active)                    [v0.3.1+]
  tools/<name>/state/ — plugin-owned runtime state (per DR-014)       [v0.11.0]
  channels/<name>/    — plugin channels (many active)                 [v0.4.0]
  providers/<name>/   — plugin AI providers (exactly one active)      [v0.4.0]
  history/<name>/     — plugin history store  (exactly one active)    [v0.5.0]
  memory/<name>/      — plugin memory system  (exactly one active)    [v0.5.0]
```

Proactive behavior (scheduled triggers, webhooks, watchers) is no longer a separate plugin type — it lives inside whichever tool plugin wants it, via the optional `ToolPlugin.start(ctx)` lifecycle hook (v0.11.0, see [DR-010](#dr-010-proactive-triggers-live-inside-tool-plugins-via-the-lifecycle-hook) and [DR-014](#dr-014-minimal-coreplugin-coupling)). The bundled `tools/schedule` is the reference implementation.

Each installed plugin directory contains a required `plugin.json` (name, type, optional description and file list) — see [DR-013](#dr-013-core-and-plugin-installation-are-decoupled--plugins-are-self-describing-defaults-are-data). Core installation (`nanogent init`) and plugin installation (`nanogent plugin add`) go through the same resolver + installer pipeline; shipped defaults live in `template/profiles/default.json` as data, not as a hardcoded list in `bin/cli.ts`.

Five plugin directories, five extensibility points:

| Plugin type | Directory | How many active? | What it does | Status |
|---|---|---|---|---|
| **Tool** | `tools/<name>/` | Many | Exposes a capability to the chat agent. Optional `start()` lifecycle hook lets a tool own background loops (the bundled `schedule` tool uses this for proactive triggers). | Implemented (v0.3.1; lifecycle v0.11.0) |
| **Channel** | `channels/<name>/` | Many | Handles a transport (`telegram`, `whatsapp`, `email`, ...) | Implemented (v0.4.0) |
| **Provider** | `providers/<name>/` | Exactly one | Implements the AI chat loop (`anthropic`, `openai`, ...) | Implemented (v0.4.0) |
| **History store** | `history/<name>/` | Exactly one | Raw append-only message log (`jsonl`, `postgres`, ...) | Implemented (v0.5.0) |
| **Memory** | `memory/<name>/` | Exactly one | Indexer + retriever over history (`naive`, `vector-rag`, `graphrag`, ...) | Implemented (v0.5.0) |

The asymmetry in "how many active" reflects real differences:
- **Tools are capabilities** — a project can have several (coding, RAG, search, calendar, schedule)
- **Channels are ingress points** — a project can have several (DM via Telegram, email, group on WhatsApp)
- **Providers are thinking layers** — a chat agent has one reasoning model per turn; multiplexing two providers within one conversation is confused, not a feature
- **History is the source of truth** — one canonical log per install; multiple stores would split the truth
- **Memory is a single lens** — the agent reasons from one context model at a time; two memories would disagree on what's relevant

Proactive behavior (scheduled triggers, watchers, pollers) was a separate plugin type in v0.7.0 – v0.10.0 (`scheduler/<name>/`). v0.11.0 collapses it into the tool extensibility point via a lifecycle hook (`ToolPlugin.start`) — see [DR-010](#dr-010-proactive-triggers-live-inside-tool-plugins-via-the-lifecycle-hook). The asymmetry "how many active" no longer needs a dedicated row: tools that need proactivity own their own loop, and tools that don't stay stateless.

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

### DR-010: Proactive triggers live inside tool plugins via the lifecycle hook

**Status:** v0.11.0 reverses the v0.7.0 design. The original "scheduler is an optional pluggable plugin type" shape (DR-010, revision 0.3) shipped in v0.7.0 – v0.10.0. v0.11.0 collapses it into the tool extensibility point. This entry documents both the reversed decision and why.

**What.** Time-based proactive triggers are implemented inside whichever **tool plugin** wants them, via the optional `ToolPlugin.start(ctx)` lifecycle hook. The bundled `tools/schedule` plugin owns the full surface area: CRUD via `execute()` (reactive path the agent calls), a minute-resolution tick loop started from `start()` (proactive path fired by core), definitions in its own `state/schedules.json`, and an append-only execution log in its own `state/log.jsonl`. Core knows nothing about scheduling as a concept — it provides one primitive (`fireSystemTurn` on `ToolStartCtx`) and one lifecycle shape (`start()` may return a stop fn that core calls on shutdown).

```ts
interface ToolPlugin {
  // ...reactive methods (execute, etc.)
  start?(ctx: ToolStartCtx): Promise<(() => void) | void>;
}

interface ToolStartCtx {
  projectName: string;
  projectDir: string;
  pluginDir: string;                    // state goes under pluginDir/state/
  fireSystemTurn(opts: {                // inject a non-user turn into the queue
    channel: string;
    chatId: string;
    contactId: string;
    text: string;
  }): void;
  log(...args: unknown[]): void;
}
```

`fireSystemTurn` remains the single entry point for non-user-initiated turns (scheduled triggers, async job completions, future webhook/watcher/poller tools). It is **not exported** from `nanogent.ts` — plugins receive it through `ToolStartCtx`. Core builds a synthetic trigger and injects it into the existing turn queue with `isSystemTrigger: true`, so the turn goes through the same memory recall → tool loop → channel send pipeline as any other turn.

**What v0.7.0 – v0.10.0 did (reversed):** a dedicated `scheduler/<name>/` plugin type with a nine-method `SchedulerPlugin` contract (`init`, `createSchedule`, `listSchedules`, `getSchedule`, `deleteSchedule`, `claimDue`, `markComplete`, `markFailed`, `listExecutions`), a core-owned tick loop that called `scheduler.claimDue`, and a `ToolCtx.scheduler` handle the bundled `schedule` tool used to reach the active plugin. All four of those — the plugin type, the nine-method contract, the core tick loop, and the tool-ctx handle — are gone.

**Why the reversal.**

- **The split made plugin dependency management confusing.** With two plugins (`scheduler` + `tools/schedule`) that only worked together, operators could install one without the other and get silent half-functionality: a scheduler plugin with no agent-facing tool to CRUD its definitions, or a schedule tool returning "no scheduler installed" errors on every call. The default profile shipped both, which papered over the problem for the happy path but left the contract ambiguous. Consolidation eliminates the mismatch.

- **The nine-method `SchedulerPlugin` contract was leaking implementation detail through the type system.** Core didn't need any of the CRUD methods — only the `schedule` tool called them. Core's only interest was `claimDue` / `markComplete` / `markFailed`, which is really "call my tick callback" wearing a costume. Once you see that core's surface area is one primitive (`fireSystemTurn`) and one callback (`start()` returning a stop fn), the whole nine-method interface was scaffolding for a relationship that didn't exist.

- **Lifecycle is the correct primitive for *any* proactive tool, not just scheduling.** Future tools that want to watch a webhook endpoint, poll an inbox, tail a log file, or listen for file-system events need exactly the same seam: "run my loop in the background, call `fireSystemTurn` when I have something to say, stop cleanly on shutdown." The lifecycle hook covers all of them. A typed `SchedulerPlugin` seam would have forced each of those to either invent its own plugin type or squat on `scheduler` as a misnomer. DR-014 formalises this: core provides primitives, plugins own implementation details, including their own lifecycle.

- **Plugin-owned state is cleaner than a shared `state/` dir.** In v0.7.0 the jsonl scheduler wrote `state/schedules.json` and `state/schedule-log.jsonl` directly under the core `state/` dir, forcing a "plugin namespaces itself by filename prefix" convention. In v0.11.0 each plugin writes under its own `pluginDir/state/`, matching the convention `tools/claude` already used since v0.8.0. Core never reaches into plugin folders; plugins never reach into `core state/`. See [DR-014](#dr-014-minimal-coreplugin-coupling).

- **`claimDue` atomicity, orphan recovery, missed-fire policy, retry policy** — all of these were plugin concerns under the v0.7.0 contract, and they stay plugin concerns under v0.11.0. The only difference is that they now live inside a tool module rather than a `SchedulerPlugin` module. The bundled `tools/schedule` preserves the same semantics: atomic claim via an append-only `claimed` log entry, orphan recovery on boot via fail-forward, no retries, one catch-up tick on boot for missed fires.

**Why the v0.7.0 shape existed in the first place.**

The v0.7.0 reasoning still holds for the *problem* (proactivity is a real capability, implementation variance across backends is genuine, definitions and execution state are tightly coupled, zero is a valid state). It was wrong about the *solution*: a dedicated plugin type was over-structured for a capability that only had one call site into core. The insight from v0.11.0 is that "implementation variance across backends" doesn't require a typed seam — it just requires that alternate backends implement the same `ToolPlugin` shape, which they already have to do. Swapping `tools/schedule` for `tools/schedule-redis` or `tools/schedule-postgres` is the same operation as swapping `tools/claude` for `tools/opencode`: install a different tool plugin.

**Consequences.**

- **`tools/schedule/state/` is plugin-owned.** Definitions (`schedules.json`) and the append-only execution log (`log.jsonl`) both live under the plugin's own dir. The plugin's own `gitignore` file lists `state/` so operator repos don't pick it up.

- **Orphan claim recovery, retry policy, missed-fire policy are still plugin-scoped.** The bundled `tools/schedule` preserves the v0.7.0 semantics: on `start()` it reads its log, fail-forwards any orphan `claimed` entries with `error: orphan-crash-recovery`, fires one immediate tick for missed-fire catch-up, then starts a 60-second interval tick. Alternative schedule-tool implementations are free to pick different policies, but they own them end to end.

- **`fireSystemTurn` is a primitive, not an export.** Plugins reach it through `ToolStartCtx`, not by importing from `nanogent.ts`. Core exports nothing to plugins except types. See DR-014.

- **`[SCHEDULED "<name>"] <prompt>` prefix is a `tools/schedule` convention, not a core convention.** The bundled plugin emits this prefix so the agent can recognise scheduled triggers. Alternative schedule tools are free to invent their own framing — the agent-side prompt engineering will just need to match.

- **Zero proactive tools is a valid state.** Operators who don't want scheduling can remove `tools/schedule/` from their profile — no tick loop runs, no state files are created, nothing else changes. The core tool lifecycle iterator just finds no tools with a `start()` hook and moves on.

- **The seven plugin directories become five.** `scheduler/<name>/` is gone; `tools`, `channels`, `providers`, `history`, `memory` remain. The `PLUGIN_TYPES` constant in `bin/cli.ts` drops the `'scheduler'` entry. `template/scheduler/` is deleted. `template/profiles/default.json` drops the `../scheduler/jsonl` entry.

- **Time zones are still punted to the agent.** Unchanged from v0.7.0: the bundled schedule tool stores `daily@HH:MM` in UTC and expects the agent to convert from the user's local wall clock before calling `schedule_create`.

- **Per-contact execution serialization is unchanged.** The existing global `turnQueue` still serializes all turns (user + system + scheduled), so scheduler fires cannot race with live user messages or async job completions.

**Checklist for writing a proactive tool plugin (schedule, webhooks, watchers, pollers):**

- [ ] Implement `ToolPlugin.start(ctx: ToolStartCtx): Promise<() => void>` — return a stop fn that tears down every timer, listener, or subscription you opened.
- [ ] Keep all state under `ctx.pluginDir + '/state/'`. Add `state/` to your plugin's `gitignore` file.
- [ ] Use `ctx.fireSystemTurn({ channel, chatId, contactId, text })` to inject non-user turns. Do not import from `nanogent.ts` — core does not export `fireSystemTurn` to plugins.
- [ ] `start()` failures are logged and swallowed by core. Don't rely on them to block boot — catch and log internally so partial state is cleaned up if one side of your init fails.
- [ ] Do not hand out your internal state to other plugins via module-level globals. If a second plugin needs to see your state, expose it through a tool call (the way `tools/schedule` exposes schedule listings via `action: list`), not through a shared import.
- [ ] Document your trigger prefix convention (if any) in your plugin's README so agent prompts can recognise your triggers.
- [ ] If you need CRUD surface for the agent, colocate it in the same plugin's `execute()` — do not split it into a separate tool plugin that depends on yours. See DR-010's reversal rationale: split-plugin dependencies introduce silent half-functionality.

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

### Writing a proactive tool plugin (v0.11.0+)

Read [DR-010](#dr-010-proactive-triggers-live-inside-tool-plugins-via-the-lifecycle-hook) and [DR-014](#dr-014-minimal-coreplugin-coupling) first. The bundled `tools/schedule` is the reference implementation — read its source before inventing your own loop shape.

See DR-010's "Checklist for writing a proactive tool plugin" for the operational rules. Short version: implement `ToolPlugin.start(ctx)`, keep state under `ctx.pluginDir + '/state/'`, use `ctx.fireSystemTurn` to inject non-user turns, return a stop fn from `start()` for clean shutdown.

### Updating plugin state location for history and memory (v0.11.0 migration)

If you're writing a history store or memory plugin, note that `HistoryStoreCtx` and `MemoryCtx` no longer expose a `stateDir` field. v0.11.0 aligned these two plugin types with the DR-014 principle: plugins own their state location, so state goes under `ctx.pluginDir + '/state/'`, same as tools. Add a `gitignore` file to your plugin (listed in `plugin.json.files`) that lists `state/`.

### DR-011: Plugins inject container dependencies via `install.sh`

**Status:** Accepted (v0.8.0)

**Context:** Until v0.7.0, the core `template/Dockerfile` hard-coded `npm install -g @anthropic-ai/claude-code` alongside the base image setup. This baked the identity of one specific plugin (`tools/claude`) directly into a file labelled "core": swapping `tools/claude` for a hypothetical `tools/opencode` — or removing the coding-harness tool entirely because a user wanted a pure-RAG bot — required editing core. That's a textbook Open/Closed violation: core should be closed for modification and open for extension, but the Dockerfile was neither.

The tool plugin system already solves this for *runtime* dependencies: swap out a plugin folder and the runtime picks up the replacement. But the Dockerfile lives a layer below the runtime, and the runtime has no influence over what the image contains. Anything a plugin needs *installed in the image* was a core concern by default, and that coupled every container-using install to whatever happened to be the v0.7.0 default tool set.

This problem generalises beyond `tools/claude`. Different coding harnesses need different CLIs (`claude`, `opencode`, `aider`, `cursor-agent`). A `rag/pgvector` memory plugin needs `postgresql-client`. A `channels/whatsapp` plugin might need `libwebp`. A `providers/local-llm` plugin wants `ollama`. None of these should require touching core.

**Decision:** Make container dependencies pluggable via a new file-level convention: any plugin folder may optionally ship an `install.sh` next to its `index.ts`. A new `nanogent build` CLI command walks every plugin folder under `.nanogent/{tools,channels,providers,history,memory,scheduler}/`, finds each `install.sh`, and splices matching `COPY` + `RUN` directives into a base Dockerfile marker, producing `.nanogent/Dockerfile.generated`. `docker-compose.yml` builds from the generated file, not the base. `nanogent init` auto-runs the build; `nanogent start` re-runs it if the generated file is missing.

**What:**

- `template/Dockerfile` is reduced to: `FROM node:24-slim`, a minimal apt baseline (`git`, `ca-certificates`), the `# __NANOGENT_PLUGIN_INSTALLS__` marker, `WORKDIR`, and `CMD`. No plugin-specific installs.
- `template/tools/claude/install.sh` owns `npm install -g @anthropic-ai/claude-code`. This is the only file in the repo that knows about the claude CLI dependency.
- `nanogent build` reads the base Dockerfile, scans plugin folders in `PLUGIN_ROOTS` declaration order (`tools`, `channels`, `providers`, `history`, `memory`, `scheduler`) with alphabetical plugin-name sort within each root, and writes `.nanogent/Dockerfile.generated`. Stable ordering protects Docker's layer cache.
- Each found `install.sh` emits one block: a comment, a `COPY <rel>/install.sh /tmp/nanogent-install/<rel>/install.sh`, and a `RUN bash /tmp/nanogent-install/<rel>/install.sh`. Docker's build context is already `.nanogent/` (because compose lives inside it with `context: .`), so plugin paths resolve directly.
- `.nanogent/Dockerfile.generated` is gitignored as a build artifact, analogous to `package-lock.json` for Docker. The base `Dockerfile` is committed; the generated file is not.
- `nanogent init` runs build at the end of init so fresh installs are immediately docker-ready. `nanogent start` runs build if the generated file is missing so one-shot starts on fresh checkouts "just work".
- If the base Dockerfile is missing the marker line, build fails loudly — a silent omission would leave the operator wondering why plugin deps never made it into the image.

**Why:**

- **OCP compliance** — the core Dockerfile no longer knows which plugins are installed. Adding or removing `tools/claude` is now purely a plugin operation; no core edit is required.
- **Co-locates the dependency with the code that needs it** — the claude tool's runtime code (`tools/claude/index.ts`) and its install script (`tools/claude/install.sh`) live in the same folder. Future plugin authors find them together, reason about them together, and delete them together.
- **Fail-loud over fail-silent** — a plugin that needs a CLI but doesn't ship an `install.sh` fails visibly at runtime (`claude: command not found`) rather than invisibly masking the dependency. The convention creates a natural slot for the dependency declaration.
- **Pure file generation, no docker daemon needed at build time** — `nanogent build` can run on any host; the docker daemon is only required at `nanogent start` time. Safe to auto-run at init.
- **Preserves layer caching** — stable discovery order (root declaration order, then alphabetical within root) means adding an unrelated plugin doesn't invalidate cached layers for existing ones.
- **Convention over API** — `install.sh` is a shell script, not a metadata JSON with an `apt` + `npm` + `pip` schema. A shell script is the maximally general contract: apt installs, npm installs, pip installs, curl-to-sh vendor installers, file downloads, and chmods all fit inside one `bash` invocation with no core changes. It trades a slightly larger trust surface (arbitrary root commands during build) for zero core coupling to package-manager choice.

**Consequences:**

- **Plugin install.sh runs as root during `docker compose build`.** This is a meaningful trust surface — installing an untrusted plugin means running its `install.sh` as root inside your build context. Plugin authors should keep install scripts minimal and auditable. Operators should treat third-party plugin installs with the same caution they'd apply to any `curl | bash` — because that's what it is.
- **A new manual step exists: `nanogent build` after adding/removing/editing plugin `install.sh` files.** `nanogent start` only auto-runs build when the generated file is *missing*, not when it's stale. Running build manually after plugin changes is the contract; stale-detection (hashing plugin contents) would add complexity for marginal benefit.
- **Trust asymmetry with pure runtime plugins.** Before v0.8.0, a tool plugin could only execute code inside `runTurn` (sandboxed by the tool invocation lifecycle and the permission model). A plugin with an `install.sh` executes code during image build *before* any permission check. Nothing in core mitigates this — it's inherent to the "let plugins modify the image" goal.
- **Build output is not a new plugin type.** It's a convention applied to existing plugin types. Every plugin can opt in via `install.sh`; none have to. (As of v0.11.0 the plugin-type extensibility points are five — tool, channel, provider, history, memory — after the scheduler type was collapsed into the tool lifecycle seam. See [DR-010](#dr-010-proactive-triggers-live-inside-tool-plugins-via-the-lifecycle-hook).)
- **The base Dockerfile is still customisable.** Operators who need a different FROM image, extra baseline apt packages, locale settings, or non-root users edit `.nanogent/Dockerfile` (which is `type: code` in the update manifest, so it's overwritten on update — re-apply local changes after `nanogent update`). The marker line must stay intact.
- **Resource requirements are surfaced as an advisory, not edited into compose.** `install.sh` only controls what's *installed* in the image; the actual `mem_limit` / `cpus` / GPU passthrough in `docker-compose.yml` stays operator-owned. As a v0.8.1 follow-up, plugins may optionally ship a `resources.json` next to `install.sh` declaring `minMemoryMb` / `minCpus` / `note`. `nanogent build` aggregates these across all plugins via `max()` (plugins share one container, so the floor is the hungriest plugin's floor — not the sum) and prints one advisory block at the end of the build, including which plugin set each max and whether `docker-compose.yml` already declares any resource limits. Missing, malformed, or partial `resources.json` files are fine: discovery warns and skips, and the build never fails on an advisory file. GPU passthrough remains out of scope — `resources.json` is advisory-only, no compose mutation, so it has nothing to declare about `device_requests` beyond a free-text `note`.

**Checklist for plugin authors adding an `install.sh`:**

- [ ] Place the file at `<plugin-root>/<name>/install.sh` next to `index.ts`
- [ ] Start with `#!/usr/bin/env bash` and `set -euo pipefail` — fail fast on install errors
- [ ] Keep it minimal and auditable — plugin operators will read this before trusting your plugin
- [ ] Prefer idempotent steps (`apt-get install -y` is already idempotent; guard vendor installers with `command -v X >/dev/null || ...` where possible)
- [ ] Do not rely on `.nanogent/` being present inside the image — the install script runs in a bare build context with only the script itself copied in. Any runtime files your plugin needs live under its plugin folder and are visible at runtime, not install time.
- [ ] Pin versions when stability matters (`npm install -g pkg@1.2.3`), accept latest only when the plugin author is willing to own the churn
- [ ] Do not write to plugin folders from `install.sh` — those files don't persist past the RUN layer, and state should live under `ctx.pluginDir + '/state/'` at runtime anyway (per DR-014)
- [ ] Document what gets installed in the plugin's README so operators know what they're opting into
- [ ] Leave executable bit set (`chmod +x install.sh`) before committing; npm pack strips it, so the CLI re-chmods on init, but git needs it
- [ ] Run `nanogent build` yourself and confirm the generated COPY + RUN lines look right before pushing a plugin update
- [ ] If your plugin has a real memory or CPU floor (LSPs, language runtimes, local models), ship an optional `resources.json` next to `install.sh` with `minMemoryMb` / `minCpus` / a short `note`. It's advisory-only — `nanogent build` prints it but never edits `docker-compose.yml`. Skip it for plugins that fit comfortably in the default footprint, so the operator isn't nagged about floors that don't matter.

### DR-012: Docker is the only supported runtime

**Context:** Through v0.8.1, `nanogent start` supported two runtimes: a host `node` process (default) and a containerised `docker compose` run (opt-in via `config.docker: true` or the `--docker` flag). Host mode existed because early versions shipped all plugin dependencies inline in the core Dockerfile — so a host running nanogent as a plain node process could "just install what core needs" (claude CLI + Node 24) and be done.

v0.8.0 changed the shape of that contract fundamentally. With DR-011, plugin dependencies moved out of core and into per-plugin `install.sh` scripts. The install contract is now *inherently container-shaped*: plugin authors can `apt-get install`, `npm install -g`, chown system paths, `curl | bash` vendor installers, and assume they run as root inside a disposable build context. Running those scripts on the host is exactly the pollution Docker was added to prevent. A dual-install contract (host-shaped + container-shaped) would double plugin-author burden, split the test matrix, and require every plugin author to answer "does this work without docker?" for capabilities that have no meaningful host-native form (GPU passthrough, system-locale tweaks, non-root users, pinned apt packages).

Making `.nanogent/` its own npm project was considered as a way to isolate node dependencies from the host project — but it's a half-measure. It only solves the node-module slice; it does nothing for system packages, global CLIs, or any of the other things `install.sh` is designed to install. The coherent path is to require docker for *all* runtime paths, not to invent a second isolation mechanism that overlaps with docker for half the use cases.

**Decision:** Make Docker the only supported runtime. `nanogent start` always runs `docker compose up --build` against `.nanogent/docker-compose.yml`. The `--node` and `--docker` flags are removed. The `docker` field in `config.json` is removed from `template/config.json` and from the `Config` interface in `types.d.ts`. The CLI fails fast with an install hint if `docker` is not on PATH.

**What:**

- `bin/cli.ts` no longer reads `config.json` for mode selection, no longer branches on `--node` / `--docker` flags, and no longer spawns `process.execPath` as a runtime path. The `start` branch is a straight-line `docker compose up --build` invocation.
- A new `requireDocker()` check runs `docker --version` via `spawnSync` before dispatching. Missing docker prints `"docker not found on PATH — install Docker Desktop or docker + compose and retry"` and exits non-zero.
- `template/config.json` ships three fields only: `projectName`, `chatModel`, `maxTokens`. The `docker` key is gone.
- `template/types.d.ts` `Config` interface drops `docker?: boolean`.
- `template/tools/claude/README.md` drops the "installed on the host OR inside the container" fork and describes the container path only. The `~/.claude` bind-mount remains the auth path.
- `README.md` rewrites the Requirements + Install & run + Node-vs-Docker sections as a single "Running in Docker" section. Node 24+ is still required on the host for the CLI (`init`, `build`, `update`), but the runtime inside the container ships its own Node.

**Why:**

- **Single-runtime coherence.** Plugin authors write one install story. Operators read one runtime story. Tests exercise one path. The matrix collapses from NxM to N.
- **Plugin contract is already container-shaped.** DR-011's `install.sh` convention assumes root, a disposable build context, and an ephemeral filesystem. Anything else violates the contract silently.
- **Host pollution is the problem docker was supposed to solve.** Running plugin installs on the host defeats the point of having an install system at all.
- **Sandbox is the default, not the opt-in.** The `claude` tool passes `--dangerously-skip-permissions`. Before v0.9.0, operators could trip that footgun by leaving `docker: false` and forgetting to harden the host. v0.9.0 removes the footgun: every `nanogent start` runs inside a container whose only view of the host is the bind-mounted project root plus `~/.claude`.
- **Pre-release simplification.** nanogent isn't published to npm yet, so there are no installed operators whose config files need a legacy-compatible read path. Deleting the old code is strictly cleaner than adding a legacy branch.

**Consequences:**

- **Docker is a hard dependency.** Hosts without docker (and without the ability to install it) cannot run nanogent. This is the intended trade.
- **First-start latency increases.** Every fresh checkout now pays a `docker compose build` on the first `nanogent start`. The base image cache amortises it after the first run; plugin `install.sh` layers are cached too as long as the scripts don't change. Operators on slow networks feel this once per machine, not per run.
- **`nanogent build` is still pure file-gen.** It does not require the docker daemon — it just writes `Dockerfile.generated`. Only `nanogent start` requires docker to actually be running. This keeps `nanogent init`'s auto-build safe on hosts where docker is installed but not currently running.
- **Dev iteration inside this repo is unaffected.** `tests/**/*.test.ts` exercise pure helpers and do not shell out to docker. For end-to-end runtime testing, the scratch-dir symlink workflow in README.md still works by running `node .nanogent/nanogent.ts` directly as a dev shortcut — that bypass is explicitly documented as a dev-only escape hatch, not a supported end-user path.
- **Runtime inside the container still hardcodes `.nanogent/`-relative paths.** DR-012 does not change the runtime contract; it only changes how the runtime is invoked from the host.
- **`--node` tests would fail if they existed.** `tests/cli.test.ts` never exercised flag-based mode switching, so this DR is a zero-test-change move. Any future tests that want to exercise `start` should stub `spawn('docker', ...)` rather than trying to run a real docker compose.

**Alternatives considered and rejected:**

- **Keep both runtimes, document "host mode is best-effort."** Rejected — "best-effort" is the same as "untested in the plugin ecosystem." Every new plugin would silently gain a second compatibility axis that nobody runs CI on.
- **Make `.nanogent/` its own npm project and run node from inside it.** Rejected — only solves node-module deps, not system packages, not global CLIs, not anything `apt-get` or `curl | bash`. Half-measure that overlaps with docker for the cases it handles and fails for the cases it doesn't.
- **Per-plugin dual install scripts (`install.sh` + `install-host.sh`).** Rejected — doubles plugin-author burden, splits the test matrix, and requires every author to answer "does this work on macOS / Debian / Alpine / Arch / RHEL?" when the whole point of docker is to eliminate that question.
- **Require docker only when any plugin ships an `install.sh`.** Rejected — opaque, surprising, and makes the "docker-or-not" question depend on which plugins happen to be installed right now. Operators would get different runtime behaviour from installing a plugin that has nothing to do with them.

**Checklist for contributors touching the start path:**

- [ ] `nanogent start` must shell out to `docker compose up --build` — no alternative runtime path
- [ ] `requireDocker()` must run before any work that assumes docker is available
- [ ] Do not read `config.docker` — the field does not exist
- [ ] Do not re-introduce `--node` / `--docker` flags
- [ ] Dev-only shortcuts (like `node .nanogent/nanogent.ts` in the scratch-dir README section) must be clearly labelled as dev-only and never promoted to a user-facing runtime path

### DR-013: Core and plugin installation are decoupled — plugins are self-describing, defaults are data

**Context:** Through v0.9.0, `bin/cli.ts` shipped a single `MANIFEST` array that enumerated every file core and default plugins ship — `tools/claude/index.ts`, `channels/telegram/README.md`, `providers/anthropic/index.ts`, and so on, 20-plus rows in one list. `nanogent init` iterated that list and dropped every file into `.nanogent/`. Adding a new default plugin meant editing core. Swapping `tools/claude` for a hypothetical `tools/opencode` meant editing core. Any third-party plugin was effectively outside the system — operators had to copy files into `.nanogent/` by hand, `nanogent update` had nothing to say about them, and there was no uniform lifecycle for install / remove / list.

At runtime, the code was already OCP-clean: `template/nanogent.ts` walks `.nanogent/<type>/<name>/` directories and imports `index.ts` without consulting any hardcoded list. DR-011 made `nanogent build` OCP-clean too: it discovers `install.sh` files dynamically. The one remaining violation was *installation itself* — the `MANIFEST` in `bin/cli.ts` was a closed list that knew every default plugin's name and every file it shipped.

**Decision:** Decouple core and plugin installation into separate code paths. Core remains a closed manifest (9 files, all non-pluggable — the runtime, the Docker harness, and the operator-owned config seeds). Plugins become self-describing directories with a required `plugin.json`, discovered and installed through a generic pipeline. The "default plugin set" moves out of code and into a profile file — `template/profiles/default.json` — that lists plugin references. Swapping a default means editing one JSON entry. Third-party plugins install through the same `nanogent plugin add <path>` code path as shipped defaults.

**What:**

- **`bin/cli.ts` gets a shrunken `CORE_MANIFEST`.** 9 entries: `nanogent.ts`, `types.d.ts`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `prompt.md`, `config.json`, `contacts.json`, `gitignore`. Every one is either `code` (always overwritten on update) or `config` (never touched on update). No plugin rows. `CORE_MANIFEST` is the non-pluggable substrate — nothing in it names any specific tool, channel, provider, history store, memory, or scheduler.
- **`plugin.json` is required on every installable plugin.** Minimal schema: `name` (filesystem-safe, no slashes, no `..`), `type` (one of `tools`, `channels`, `providers`, `history`, `memory`, `scheduler`), optional `description`, optional `files` (explicit file list, relative paths, shallow). `name` and `type` together decide where the plugin lands: `.nanogent/<type>/<name>/`. JSON over YAML because the project already speaks JSON for every operator-facing file (`config.json`, `contacts.json`, `resources.json`, `schedules.json`) and a new parser dependency buys nothing.
- **`readPluginManifest(sourceDir)` validates and parses.** Throws with a helpful message on missing file, invalid JSON, bad name, bad type, or `files` entries with `..` or absolute paths. Deliberately strict — a plugin that can't be trusted to ship a well-formed manifest can't be trusted to ship a well-formed `install.sh` either.
- **`resolvePlugin(ref, baseDir): ResolvedPlugin`** is the single plugin-ref resolver. v1 supports local paths only — absolute, or relative to `baseDir`. When called from the profile path, `baseDir` is the profile file's directory. When called from `plugin add <path>`, `baseDir` is `process.cwd()`. The resolver returns `{ sourceDir, manifest, files }`, where `files` defaults to every non-hidden top-level file in the source dir when the manifest omits it.
- **`installPlugin(resolved, nanogentDir, { force }): InstallPluginResult`** is the single plugin installer. Copies every file in `resolved.files` (plus `plugin.json` itself, always) into `.nanogent/<type>/<name>/`. Applies two filename conventions: a file literally named `gitignore` is copied as `.gitignore`, and `install.sh` is `chmod 0o755` after copy — both workarounds for `npm pack` stripping leading dots and executable bits. Refuses to overwrite an existing plugin dir unless `force` is set.
- **`listInstalledPlugins(nanogentDir)`** walks `.nanogent/<type>/<name>/` and returns every dir containing a valid `plugin.json`. Dirs without one are logged and skipped with a migration-hint message. Dirs where the manifest declares a different `name` or `type` than the directory says are logged and skipped — a defence against name spoofing in third-party tarballs.
- **`composeUpdateEntries(tplRoot, cwd, log): ManifestEntry[]`** drives `runUpdate`'s default path. Returns `CORE_MANIFEST` plus one `plugin`-typed entry per file in every installed plugin. For each installed plugin it tries to locate a shipped source at `<tplRoot>/<type>/<name>/`; if missing (third-party plugin), the whole plugin is logged as `skipped: ... (no shipped source)` and the operator keeps whatever they installed. If present, every file listed in the installed manifest is mapped back to the shipped source, with the forward `gitignore` → `.gitignore` rename applied on the dest side. The existing byte-equal / skip-unless-force semantics carry over unchanged.
- **Profiles live under `template/profiles/`.** Two ship today: `default.json` (the 7 current defaults: `tools/claude`, `tools/schedule`, `channels/telegram`, `providers/anthropic`, `history/jsonl`, `memory/naive`, `scheduler/jsonl`) and `minimal.json` (empty plugin list — a deliberately-broken starting point for operators who want to author everything from scratch). Refs in the default profile point at `../tools/claude` etc., resolved relative to the profile file's directory. Operators point `nanogent init --profile <path>` at their own profile file to ship an opinionated set for their team.
- **`nanogent init` runs in three phases.** Phase 1: copy `CORE_MANIFEST` into `.nanogent/`. Phase 2: load the profile (default = `template/profiles/default.json`, overridable with `--profile <path>`) and install each referenced plugin via the same `resolvePlugin` + `installPlugin` pipeline third-party plugins use. Phase 3: run `runBuild()` to seed `Dockerfile.generated`. The post-init `next:` hint is unchanged.
- **`nanogent plugin <sub>` is a new subcommand with three verbs.** `plugin list` walks the installed plugin tree and prints `<type>/<name> — <description>` lines. `plugin add <path> [--force]` resolves + installs + re-runs `runBuild` so any new `install.sh` makes it into the next image build. `plugin remove <name> [-f]` finds the matching installed plugin, prompts unless `-f`, and `rm -rf`s the directory before re-running `runBuild`. Ambiguous name matches (the same `<name>` under two different `<type>`s) error out with a hint to pass `<type>/<name>`.
- **`nanogent update` composes entries from both phases automatically.** `runUpdate` now accepts an optional explicit `manifest` in `UpdateOptions` (tests use it), but its default behaviour is `composeUpdateEntries(tplRoot, cwd, log)`. The wire semantics for each entry type are unchanged: `code` always overwrites, `config` never touches, `plugin` byte-equal-or-skip-unless-force.

**Why:**

- **The `MANIFEST` array was the OCP hole.** Every other extension point in the codebase already walked directories: runtime plugin discovery, `install.sh` discovery, `resources.json` discovery. Installation was the one hardcoded list. Closing the hole means `bin/cli.ts` no longer names `claude`, `telegram`, `anthropic`, `jsonl`, `naive`, `schedule`, or any other specific plugin — the CLI is now closed to modification and open to extension in the literal sense.
- **Plugins are self-describing, so installation becomes a uniform pipeline.** Whether a plugin came from the shipped `default` profile, from a custom operator profile, or from `nanogent plugin add ~/my-plugin`, it goes through the same `resolvePlugin` + `installPlugin` code path. There is no second-class citizen.
- **Defaults are data, not code.** Adding `tools/opencode` as a default means adding one entry to `template/profiles/default.json` — not editing `bin/cli.ts`. Shipping an opinionated team profile means authoring a JSON file, not forking the CLI.
- **`--profile <path>` makes profiles a real extension point.** If the profile mechanism existed but only one profile was accessible, it'd be a hardcoded array with extra steps. Accepting a `--profile` argument proves the mechanism is real: operators can author their own profiles from day one, the CLI didn't have to ship them a "scaffold" first.
- **JSON over YAML for the manifest.** No new dependency, no new parser, same shape as every other operator-facing file in the project. The ergonomic gap (quoting, trailing commas) is a non-issue for a ~5-field machine-read file.
- **`plugin.json` required, not optional.** An optional manifest splits discovery into two paths (dir-walk vs manifest-read) and makes the third-party-plugin story ambiguous. Requiring it means every installed plugin is a real declarative unit, and `listInstalledPlugins` has a single, simple contract.
- **Local-path resolver only for v1.** Git URLs, npm packages, and a lock file (`.nanogent/plugins.lock.json`) are the obvious next features, but designing them up front forces decisions about versioning and network behaviour that v1 doesn't need. Vendoring the 7 defaults inside the `nanogent` npm package as local paths means zero-network `init` today and a clean path to network refs tomorrow — just one more branch inside `resolvePlugin`.
- **Phase-2 update tolerates third-party plugins.** Operators installing a non-default plugin via `plugin add` keep whatever they installed when they run `nanogent update` — core updates fire as usual, but a plugin with no matching shipped source is logged as `skipped: (no shipped source — third-party plugin)` and left alone. The alternative (force them to choose between core updates and custom plugins) would have made the extension point user-hostile.

**Consequences:**

- **`bin/cli.ts`'s functional code no longer hardcodes any plugin name.** No code path branches on `"claude"`, `"telegram"`, `"anthropic"`, or any other specific plugin. The only plugin vocabulary in logic is the generic extension-point names (`tools`, `channels`, `providers`, `history`, `memory`, `scheduler`) in `PLUGIN_TYPES`. A few plugin names still appear in prose — the `TELEGRAM_BOT_TOKEN` / `ANTHROPIC_API_KEY` post-init `next:` hint assumes the default profile, and the DR-011 / DR-013 context comments reference `tools/claude` as a historical example. These are strings the operator reads, not strings the CLI dispatches on; they have zero effect on how the CLI resolves, installs, or runs anything.
- **The `nanogent` npm package still ships zero-network.** Defaults are vendored under `template/<type>/<name>/` exactly as before (the profile just points at relative paths), so `nanogent init` makes no network calls. Nothing about the install experience got slower or less reliable.
- **Third-party plugins are first-class.** Any operator can `mkdir -p plugins/tools/mytool`, drop a `plugin.json` + `index.ts` + optional `install.sh`, and run `nanogent plugin add ./plugins/tools/mytool`. The plugin appears in `plugin list` alongside the defaults. It survives `nanogent update`. If it ships an `install.sh`, the next `nanogent build` layers its dependencies into the image. No core edits, no forking, no manual file copying.
- **`plugin.json` is now a required plugin-author artifact.** Existing v0.9.0 installs won't have one. Since v0.9.0 isn't published to npm and the user base is effectively "people who ran `nanogent init` from this repo in the last few days", the migration is: delete `.nanogent/` and re-run `nanogent init`, or hand-author a `plugin.json` in each plugin dir. Documented in the README "Migrating from 0.9.0" section. `listInstalledPlugins` logs a clear warning for dirs missing a manifest rather than silently ignoring them.
- **`listInstalledPlugins` is a trust boundary for name/type.** If a plugin.json declares `name: "telegram", type: "channels"` but lives at `.nanogent/tools/claude/`, it's rejected with a mismatch warning. This blocks a class of footgun where a tarball's internal manifest disagrees with the directory it was extracted to (say, via tar traversal or operator misfiling).
- **Filename conventions are part of the plugin contract.** Plugin authors who need to ship a `.gitignore` write `gitignore` in the source and list it in `files`. Plugin authors who need an executable script write `install.sh` and the installer sets the mode bit. Any other rename convention — say, `env.example` → `.env.example` — is not supported and would require a new convention entry in this DR. Authors who need more complex file handling should ship a post-install shim rather than asking the installer to learn it.
- **Shallow file copies only.** `defaultPluginFiles` does `readdirSync` without recursion, so plugins that need a nested asset directory (`assets/img/logo.png`) must list each file explicitly in `manifest.files`. The manifest validator allows subdir paths in `files` entries as long as they don't contain `..` or start with `/`. A future recursive-walk mode is a candidate for a later DR if the flat convention proves too limiting.
- **Profile resolution is explicit about its base dir.** Refs in a profile are resolved against the profile file's own directory (not against `process.cwd()`). This is what makes `template/profiles/default.json` with `"../tools/claude"` work no matter where the operator runs `nanogent init` from. Custom profiles should use the same convention: paths relative to the profile file, not to the project root.
- **The `plugin` type tag survives in `EntryType` even though `CORE_MANIFEST` doesn't use it.** Phase-2 update emits synthetic `plugin`-typed entries via `composeUpdateEntries`, so the byte-equal / skip-unless-force semantics in `runUpdate` stay in one place rather than duplicating.
- **No lock file in v1.** Versioning, integrity hashes, and origin tracking are explicitly deferred. Phase-2 update re-resolves each installed plugin against the shipped source by walking; there's no "installed ref" state to go stale. The cost is that operators can't pin a third-party plugin to a specific source ref — when a local-path plugin moves or disappears, `update` just logs it as `(no shipped source)` and moves on. A `.nanogent/plugins.lock.json` is the obvious home for that when git/npm refs land.

**Alternatives considered and rejected:**

- **Hardcoded `DEFAULT_PLUGINS` array in `bin/cli.ts`.** The minimum-viable "decoupling": split `MANIFEST` into core and plugin halves, keep both as TypeScript constants, don't introduce profiles. Rejected — the plugin half is still code that every new default edits. OCP-purely, defaults must be data that's replaceable without modifying core. Shipping an opinionated team profile would still mean forking the CLI package.
- **Each plugin is its own npm package, fetched on `init`.** The most decoupled option: `default.json` lists npm package names, `nanogent init` runs `npm install` for each, plugins ship independently with independent versioning. Rejected for v1 — `init` becomes network-dependent, plugin versioning surface explodes, every default plugin needs its own repo and release cadence, and the "clone nanogent, run init, see the agent boot" dev loop loses its zero-network property. The current design doesn't preclude this: `resolvePlugin` is the single choke point, and adding an `npm:` or `git+https://` ref prefix there is a later-DR move.
- **Per-plugin-conditional docker requirement as the pattern.** Related DR-012 alternative. Rejected there and rejected here: extension points shouldn't toggle cross-cutting infrastructure based on which plugins are installed.
- **Optional `plugin.json`, fall back to dir-walk.** Rejected — splits plugin discovery into two code paths, makes third-party plugins a second-class citizen (no metadata, no description, no explicit file list), and makes the name/type mismatch check impossible. Requiring the manifest is strictly cleaner.
- **YAML for the plugin manifest.** Rejected — no YAML parser in tree, every other operator-facing file in the project is JSON, and a 5-field machine-read file doesn't benefit from YAML's multiline ergonomics.
- **Persist an installed-plugin lock file on `plugin add`.** Rejected for v1 — v1 has no versioning and no non-local refs, so there's nothing to lock. The lock file becomes load-bearing only when git/npm refs or integrity hashes land, at which point it earns its keep.
- **Eagerly validate profiles by resolving every ref at load time.** Rejected — `loadProfile` only validates shape (name, array-of-refs). Ref resolution happens at install time, per-ref, so one broken ref in a profile with ten plugins still installs the other nine successfully (the broken one exits non-zero with a clear `init failed on plugin '<ref>'` message). The operator can fix or remove that one entry and re-run.

**Checklist for plugin authors:**

- [ ] Ship a `plugin.json` at the plugin root with at minimum `name` and `type`. The `name` must match the directory name the operator installs into (e.g. `{"name": "mytool", "type": "tools"}` lands at `.nanogent/tools/mytool/`).
- [ ] If your plugin ships files that need renaming on install — specifically a `gitignore` that should become `.gitignore` — declare an explicit `files` list in the manifest. The default file list skips hidden files, so an installed `.gitignore` would be dropped by `nanogent update`'s phase-2 walk unless the manifest names the source-side `gitignore`.
- [ ] If your plugin needs container dependencies, ship an `install.sh` (see DR-011). The installer will `chmod 0o755` it automatically. List it in `files` if you're declaring an explicit list; otherwise the default walker picks it up.
- [ ] If your plugin has a real memory or CPU floor, ship an optional `resources.json` (see DR-011). Same rules as before — advisory-only.
- [ ] Keep `files` shallow. Nested asset dirs must be listed explicitly (e.g. `"files": ["index.ts", "assets/logo.png"]`). No recursive walk in v1.
- [ ] Do not name your plugin with a path separator or `..`. The manifest validator rejects it and the install will fail.
- [ ] For third-party plugins, publish a local-path reference in your README (e.g. `nanogent plugin add git-cloned/my-plugin`). Git and npm refs are a future enhancement.
- [ ] Test your plugin's round-trip: `nanogent plugin add <path>`, `nanogent plugin list` (see it appear), `nanogent plugin remove <name>` (see it disappear).

**Checklist for contributors touching core installation:**

- [ ] `CORE_MANIFEST` must contain only files that are non-pluggable substrate (runtime, docker harness, config seeds). No plugin files.
- [ ] `bin/cli.ts` must not name any specific plugin. If you catch yourself writing `"claude"` or `"telegram"` in a string literal, you're violating this DR. Route through `PLUGIN_TYPES` or the profile system instead.
- [ ] A new default plugin is one entry in `template/profiles/default.json` plus the usual `plugin.json` next to its source files. It is never a new entry in `CORE_MANIFEST`.
- [ ] New profile refs must be relative paths from the profile file's directory (not `process.cwd()`-relative).
- [ ] Anything that adds a new filename convention (like `gitignore` → `.gitignore`) must be documented in this DR's plugin-author checklist and applied symmetrically in both `installPlugin` and `composeUpdateEntries`.

### DR-014: Minimal core↔plugin coupling

**Status:** Accepted (v0.11.0). Ratifies a direction the codebase was already drifting in (`tools/claude/state/` since v0.8.0) and applies it uniformly.

**Principle:** Core provides primitives. Plugins own implementation details. The coupling surface in each direction is a tiny, fixed contract — and nothing more.

**Context:** By v0.10.0 nanogent had accumulated several places where core reached further into plugin implementation than it should have. The typed `SchedulerPlugin` seam (nine methods, most of them useful only to the `schedule` tool that called them) was the worst offender, but the pattern also showed up in subtler ways: `HistoryStoreCtx` and `MemoryCtx` handed plugins a `stateDir` field pointing at a shared `.nanogent/state/` tree with a "plugin should namespace under its own subdir" comment, implicitly pretending core could reason about a shared state namespace without actually owning the shape of what went into it. Core validated specific plugin method names at load time (`typeof scheduler.claimDue !== 'function'`) — harmless in isolation but a signal that core knew too much about what a plugin was.

None of this was load-bearing in the "without this, the runtime breaks" sense. It was all *accumulated coupling debt*: small decisions where, when in doubt, core knew one more thing about plugins than it strictly needed to. DR-014 names the principle that should have guided those decisions, so future extension work starts from it instead of accumulating the same debt.

**Decision:** Make the coupling surface between core and plugins explicitly minimal. Core provides a small, fixed set of primitives via ctx objects, and a small, fixed set of lifecycle hooks it will call. Everything else — state location, state format, state migration, background loop management, file layout, update-time preservation semantics — is the plugin's concern, invisible to core.

**What core owns:**

- **Plugin discovery.** Walk `PLUGIN_ROOTS`, find every directory containing a valid `plugin.json`, import its `index.ts`.
- **Lifecycle orchestration.** Call `init()` / `start()` in a known order at boot; call the returned stop fn in reverse order at shutdown. Wrap each call in try/catch so a buggy plugin never blocks boot.
- **Shared primitives handed to plugins via ctx objects.** `fireSystemTurn` (inject a non-user turn), `log` (namespaced logger), the existing per-tool channel-send handles on `ToolCtx`, `newJobId` / `backgroundJob` / `busy` for long-running tools. These are *named operations*, not a reflection system or an event bus.
- **Contract type checks.** Verify the loaded module exports the required methods; if not, log and skip that plugin with a clear error. Core never calls a method that isn't part of the published contract.

**What plugins own:**

- **State location.** Core hands `pluginDir`; plugin decides what subtree (e.g. `pluginDir/state/`) and what files to create.
- **State shape and format.** JSON, JSONL, SQLite, binary — core never looks inside.
- **State migration across plugin versions.** When a plugin's storage schema changes between revisions, the plugin handles its own migration inside `init()` / `start()`. Core does not know a schema exists, so it cannot assist; asking core to assist would recreate the coupling the DR is trying to eliminate.
- **Install-time side effects.** Container dependencies via `install.sh` (DR-011). Build-time scripts run as root but the *decision* of what to install lives entirely in the plugin.
- **Resource advisories.** Optional `resources.json` (DR-011). One tolerated exception to "core never parses plugin-owned data files" — the advisory is opt-in, advisory-only, and never load-bearing. Core reads it only to print a build-time hint.
- **Lifecycle internals.** A plugin's `start()` can spawn timers, workers, file watchers, webhook listeners, whatever — core doesn't care what happens inside, only that the returned stop fn tears it all down cleanly.
- **The plugin's entire file layout under its directory.** Tools ship `index.ts` + `plugin.json` + optional `README.md` + optional `install.sh` + optional `gitignore` + optional `state/` subdir. Future plugins can ship whatever they need. The only files core ever touches are the ones listed in the plugin's own `plugin.json.files`.

**The coupling surface — deliberately tiny:**

*Plugin → core:* a default export matching one of five typed interfaces (`ToolPlugin`, `ChannelPlugin`, `ProviderPlugin`, `HistoryStorePlugin`, `MemoryPlugin`) with a fixed small set of methods. No reflection, no event bus, no dynamic registration. Adding a method to a plugin interface is a type-level change that propagates through every implementation the same way.

*Core → plugin:* one ctx object per lifecycle call (`ToolStartCtx`, `ChannelCtx`, `HistoryStoreCtx`, `MemoryCtx`), containing a fixed small set of data fields and primitive functions. Plugins use only the ctx fields they need. Core never injects a field "in case future plugins want it."

**What this rules out:**

- Core reading or writing inside plugin folders beyond the MANIFEST-driven init/update copy.
- Core parsing plugin-owned data files (the `resources.json` advisory is the one tolerated exception — opt-in, advisory-only, never load-bearing).
- Core dictating state location, format, or migration strategy.
- "Well-known paths" under a shared `.nanogent/state/<convention>/` tree where multiple plugins implicitly share a namespace.
- Module-level exports from `nanogent.ts` intended to be imported by plugins. The `fireSystemTurn` primitive was previously exported for this reason; v0.11.0 un-exports it and hands it through `ToolStartCtx` instead.

**Consequences.**

- **`ToolPlugin` gains a lifecycle hook.** `start?(ctx: ToolStartCtx)` is optional. Tools that don't need it (claude, search, rag) don't implement it and pay no cost. Tools that do (schedule, future webhook listeners, future pollers) own their loop internally and return a stop fn. Core's tool boot loop iterates every tool, calls `start()` if present, wraps in try/catch, collects stop fns, tears them down on shutdown in reverse order.

- **`HistoryStoreCtx` and `MemoryCtx` drop `stateDir`.** `pluginDir` stays; `stateDir` is gone. Both ctxs now pass the same symmetric "here's your folder, do what you like" pattern. The bundled `history/jsonl` plugin now writes under `pluginDir/state/` (previously `stateDir/history/`). `memory/naive` didn't use `stateDir` at all (it derives everything from history), so its migration is a no-op.

- **The nine-method `SchedulerPlugin` type is deleted.** Its CRUD surface was a relationship between the tool and the backend, not between core and the backend. Collapsing both into one `ToolPlugin` (the bundled `tools/schedule`) eliminates the type entirely. See [DR-010](#dr-010-proactive-triggers-live-inside-tool-plugins-via-the-lifecycle-hook) for the reversal.

- **`fireSystemTurn` is un-exported.** Plugins receive it through `ToolStartCtx.fireSystemTurn`. The old `export function fireSystemTurn(...)` is gone. This prevents future plugins from reaching into core by import path and keeps the coupling surface inside the ctx objects where it's visible.

- **A buggy `start()` logs and continues.** Core wraps each `start()` in try/catch. A plugin whose initialization crashes is logged as `tool <name> start() failed — <message>` and skipped; the rest of boot proceeds. Operators see the error and can remove or fix the plugin. The alternative (let one plugin's bug crash the agent) is strictly worse.

- **Symmetrical with `ChannelPlugin.start` that already exists.** Channel plugins have returned an optional stop fn from their `start(ctx)` method since v0.4.0. Tool lifecycle mirrors the same pattern: same return shape, same stop semantics, wrapped in the same try/catch. Future plugin types that need lifecycle can copy the shape without inventing new conventions.

- **`core state/` is smaller.** After history moves out, `.nanogent/state/` contains only `jobs.json` (the core job registry) and `learnings.md` (the core learn tool). Every other piece of runtime data lives under its owning plugin's directory. The top-level `.nanogent/.gitignore` still covers `state/` for the core files.

- **History/memory plugin authors update their init.** The migration from `ctx.stateDir` to `ctx.pluginDir + '/state/'` is a one-line change per plugin plus adding a `gitignore` file. The plugin-author guidance sections have been updated in-place.

- **No further ctx injection without justification.** Adding a new field to any plugin ctx object should be treated as a capability expansion that affects every plugin of that type. The bar is: "can I name a primitive that isn't representable by combining existing fields?" If not, the field doesn't belong in ctx. This is the rule that prevents ctx objects from accumulating "nice to have" properties over time.

- **Future plugin types inherit the principle.** When a new plugin type is added (a hypothetical `observability` or `audit` plugin), its ctx object starts from the same minimal baseline — `projectName`, `projectDir`, `pluginDir`, `log`, plus only those primitives whose job it is to hand the plugin *something it cannot produce itself*.

**Checklist for contributors extending core:**

- [ ] Before adding a field to any plugin ctx object, justify it against "is this a primitive the plugin cannot produce itself?" Configuration knobs, convenience handles, pre-computed derived state — none of these belong in ctx.
- [ ] Before adding a method to any plugin interface, check whether core actually calls it. If the only caller is another plugin, the method belongs on the caller plugin's internal surface (accessed via its own `execute()` or its own state), not on the shared interface.
- [ ] Before exporting a helper from `nanogent.ts` to be imported by plugins, check whether the ctx pattern can cover it. Default to ctx injection; reserve module exports for shared *types* (which are compile-time only and carry no runtime coupling).
- [ ] When a plugin needs state, it owns the location under `pluginDir`. Do not introduce new paths under the top-level `.nanogent/state/` tree — that dir is for core runtime state only.
- [ ] When a new lifecycle hook is needed, copy the shape of the existing `ChannelPlugin.start` / `ToolPlugin.start` pair: async, may return a stop fn, wrapped in try/catch, torn down in reverse at shutdown.

### DR-015: Portable state via per-type data contracts

**Status:** Proposed (v0.11.0 lands the principle in DESIGN.md; code implementation is deferred to v0.12.0). The principle influences v0.11.0 data-layout decisions (keep schedule definitions and execution log in separate files — portable vs non-portable — even though no export/import code ships yet).

**Principle:** Each plugin type that holds state defines a small, canonical data envelope. Plugins of the same type can migrate data between themselves via this envelope. Core orchestrates the hand-off but never looks inside.

**Context:** [DR-014](#dr-014-minimal-coreplugin-coupling) establishes that plugins own their state end to end. A direct consequence: swapping one plugin implementation for another (e.g., `history/jsonl` → `history/sqlite`) is a data migration problem that core cannot solve, because core doesn't know what's in the files. But the plugins *can* solve it if they share a canonical envelope for export/import at the type level.

Without this DR, "swap your history backend" silently means "abandon your old conversations." That's a bad story for any operator who wants to move from the default `jsonl` to a durable SQL-backed store once their install grows past the point where jsonl files are practical.

**Decision:** Each plugin type that holds state (history, and the proactive tools that hold state like `tools/schedule`) declares a canonical `Portable<T>` interface for export/import. Plugins of that type implement it. Operators drive plugin-to-plugin migration through a future `nanogent plugin migrate <type> <from> <to>` CLI verb that pipes `old.export()` → `new.import(data)`. Core orchestrates the hand-off without parsing the envelope.

**What the contract looks like:**

```ts
// Shared capability interface — one definition, reused per type.
interface Portable<TExport> {
  export(): Promise<TExport>;
  import(data: TExport): Promise<void>;
}

// Per-type envelope — defined in types.d.ts alongside the plugin interface.
interface HistoryExport {
  version: 1;
  messages: Record<string, HistoryMessage[]>;  // contactId → messages
}

// Plugin interfaces extend Portable<T> when portability is part of the contract.
interface HistoryStorePlugin extends Portable<HistoryExport> {
  // ...existing ops
}
```

Methods on `Portable<T>` are **required**, not optional. If a plugin type declares portability, every implementation of that type must implement it. A plugin that can't support export/import shouldn't claim to be that plugin type — it should pick a different contract or return a clear "not supported" error inside `export()`. This pushes the "optional capability" question to the plugin type level, where it belongs.

**Per-type portability stories (they're not all the same):**

1. **History** — source of truth. Needs full `export`/`import`. Envelope is trivially `{ version, messages: contactId → messages[] }`.

2. **Memory** — derived view on history. Does NOT need `export`/`import`. The swap story is "reindex from the history store": the new plugin's `init()` walks history via the existing `ctx.history` handle and rebuilds its index. This is already possible under the current contract; v0.12.0 will make "initial backfill on empty index" an explicit convention in the memory plugin-author checklist.

3. **Proactive tools that hold state (`tools/schedule` today)** — source of truth for *definitions*, plugin-internal for *execution log*. `export`/`import` covers definitions only. Execution log is deliberately non-portable — it's implementation telemetry, not data the operator cares about preserving across a swap. This is why `tools/schedule` keeps definitions (`schedules.json`) and the log (`log.jsonl`) in separate files, so a future `export()` can dump one and ignore the other.

4. **Tools in general** — stateless, no contract needed. Only tools that hold state declare portability. A `tools/webhook-listener` might ship persistent subscription state; a `tools/search` wouldn't. Each tool opts in as its own state demands.

**The migration flow (v0.12.0):**

```
nanogent plugin migrate history jsonl sqlite
```

Core does: load old plugin → `old.export()` → load new plugin → validate envelope version → `new.import(data)` → swap active plugin reference → operator removes old plugin folder. Core touches no files, parses no formats, understands no schemas. Pure plumbing.

**Version skew:** the envelope carries a `version` field. The importer decides what to do: accept, migrate up, or reject with a clear error. Core's role is only to refuse the migrate command if versions are incompatible and no in-plugin migration path exists. Forward/backward compatibility is a plugin concern, where it belongs.

**Export is also a backup primitive.** `nanogent plugin export history > backup.json` dumps to stdout → operator commits or archives the JSON → `nanogent plugin import history < backup.json` restores. Free side-effect of the contract.

**Why a capability interface, not optional methods.**

Two candidates were considered:

1. Inline optional methods on each plugin interface: `export?()` / `import?()` on `HistoryStorePlugin`.
2. A named capability interface: `interface Portable<T> { export(); import(); }` extended by plugin interfaces that declare portability.

The named capability wins for four reasons:

- **Documents intent at a glance.** `HistoryStorePlugin extends Portable<HistoryExport>` tells a reader that portability is part of this type's contract. Inline `export?` hides the capability in the middle of a longer interface.
- **Runtime checks are real type guards.** `isPortable(plugin)` is a concrete check, not duck-typing two method names.
- **Reusable across plugin types.** History, schedule-tool state, and any future stateful type extend the same `Portable<T>` shape. Each re-declaring optional methods would be duplicate work and duplicate drift risk.
- **Breaking changes are cheaper to avoid now.** Lifting optional methods into an interface later is a breaking change for every plugin that implemented the old shape. A named interface locks the shape on day one.

The weak objection (`Portable<T>` is "one more type to learn") is outweighed: it's a three-line interface and matches a pattern plugin authors already understand from other TypeScript ecosystems.

**Why ship the principle in v0.11.0 even without code.**

v0.11.0 reshapes several plugin types (history, memory, the new `tools/schedule`) and their on-disk layouts. Some decisions in that reshape are load-bearing for v0.12.0's implementation:

- **Schedule definitions and execution log must stay in separate files.** If `tools/schedule` had merged them into one file, v0.12.0's `export()` would need to parse the combined format to split out the portable half. Keeping them separate now means `export()` is a trivial read of `schedules.json`.
- **`pluginDir/state/` as the storage convention is compatible with future `export()`/`import()`.** The plugin reads its own adjacent state — no path injection from core.
- **Plugin authors writing today's plugins should know the shape that future portability will take,** so they don't accidentally design themselves into a corner (e.g., encrypting every field in a way that makes export impossible).

**Consequences (v0.11.0 scope — no code, just shape).**

- **No `Portable<T>` type is added to `types.d.ts` yet.** It lands in v0.12.0 when implementation is wired up. DR-015 describes the shape in prose so authors know what to design toward.
- **`HistoryStorePlugin`, `MemoryPlugin`, and `ToolPlugin` interfaces are unchanged** from the v0.11.0 refactor. They do not yet extend `Portable<T>`.
- **`bin/cli.ts` does not gain `plugin migrate` / `plugin export` / `plugin import` subcommands yet.** Those land with v0.12.0.
- **`tools/schedule` keeps definitions and log in separate files** (`schedules.json` + `log.jsonl`), deliberately, so v0.12.0's `export()` is a one-line `readFileSync(schedulesPath)`.
- **Memory swap story will be "reindex from history," not "export/import the index."** v0.12.0 will document this in the memory plugin-author checklist.

**Consequences (v0.12.0 scope — for future reference).**

- **`export()` / `import()` become required methods on every history store implementation.** Any in-tree history plugin that fails to implement them is a bug, not a degraded capability.
- **The envelope is versioned from day one.** Envelopes without a `version` field are rejected. v1 is the starting version.
- **The migrate CLI is unidirectional per invocation.** `nanogent plugin migrate history jsonl sqlite` is a one-way hand-off. There is no "undo" — the old plugin's files stay on disk until the operator removes them manually, and the operator is expected to keep both plugins installed until they've verified the new one works.
- **Operators are responsible for *which* data is in flight during migration.** Running `migrate` on a live agent is unsupported — stop the agent, migrate, start the agent. The contract does not include "drain the queue, pause writes, atomic cutover." Plugins that need live migration are welcome to implement it internally, but core will not provide primitives for it in v0.12.0.

**Open extensions (deferred to specific future DRs when concrete needs land):**

- **`onUpdate?(ctx)` hook** — called when the plugin's own files are about to be rewritten by `nanogent update` so the plugin can migrate its state across plugin-version bumps. Not the same thing as plugin-to-plugin export/import; this is within-plugin schema migration.
- **Verified integrity on import** — content hashes on the envelope so the importer can detect corruption or tampering mid-pipe. Out of scope for v0.12.0.
- **Streaming export for huge datasets** — v0.12.0 assumes the full envelope fits in memory. A sqlite history with 10M messages would argue for a streaming protocol. Revisit when anyone actually has that.

**Checklist for plugin authors designing for future portability:**

- [ ] Keep portable and non-portable state in separate files. If your plugin holds "the canonical data" and "implementation telemetry" (execution logs, internal indexes, cached derivations), split them now so a future `export()` can dump the portable half cleanly.
- [ ] Store dates as ISO 8601 strings, not native Date objects. Envelopes cross process and language boundaries; string dates survive JSON serialization with no timezone drift.
- [ ] Treat `contactId` as an opaque identifier in every envelope. Do not assume it's a username or a numeric ID. Migration between plugins must preserve contactIds byte-for-byte.
- [ ] Version your plugin's internal schema from day one, even if v1 is the only version. Bumping later is a breaking change; introducing versioning later is a coordination nightmare.
- [ ] When in doubt about whether to ship state inside the `export()` envelope or behind a re-derive-from-source pattern, ask: "is this data that the operator would mourn losing if they swapped plugins?" If yes, it's portable; if no, leave it out and let the new plugin recompute.

---

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
- **0.3 (2026-04-15)** — Added DR-010 (scheduler is an optional pluggable proactive trigger source). Captures the v0.7.0 introduction of an optional zero-or-one scheduler plugin type, the 9-method `SchedulerPlugin` contract (definition CRUD + claimDue/markComplete/markFailed + listExecutions), the core-owned `fireSystemTurn` helper as the single entry point for non-user-initiated turns, the once-a-minute tick loop, the definitions-vs-execution-log split in the bundled `scheduler/jsonl` default, and the rationale for keeping definitions/execution in a single plugin while keeping the scheduler itself optional.
- **0.4 (2026-04-15)** — Added DR-011 (plugins inject container dependencies via install.sh). Captures the v0.8.0 move of container-side installs out of the core Dockerfile and into per-plugin `install.sh` scripts composed by `nanogent build` into `Dockerfile.generated`, the rationale (OCP — swapping `tools/claude` for a hypothetical `tools/opencode` no longer requires editing the core Dockerfile), the stable discovery order for layer-cache stability, the root-execution trust surface it introduces during `docker compose build`, and the explicit deferral of per-plugin compose-level resource requirements (`mem_limit`, `cpus`, GPU passthrough) to a future decision.
- **0.5 (2026-04-15)** — Reversed the DR-011 deferral on resource requirements: v0.8.1 adds an optional per-plugin `resources.json` next to `install.sh` declaring `minMemoryMb` / `minCpus` / `note`. `nanogent build` discovers these, aggregates with `max()` semantics (plugins share one container), and prints one advisory block per build naming the hungriest plugin and whether `docker-compose.yml` already declares resource limits. Pure advisory — no compose mutation, no build failure on missing/malformed files. Updated the DR-011 Consequences paragraph and plugin-author checklist to cover the new optional file.
- **0.6 (2026-04-15)** — Added DR-012 (Docker is the only supported runtime). v0.9.0 removes the host-node path and the `--node`/`--docker` flags: `nanogent start` always runs `docker compose up --build`, the CLI fails fast if `docker` is missing from PATH, `config.json` no longer carries a `docker` field, and `types.d.ts` drops it from `Config`. Rationale: DR-011's `install.sh` contract is inherently container-shaped, so supporting a host runtime would force a dual-install contract that doubles plugin-author burden and splits the test matrix. Removed the "node-mode users unaffected" consequence from DR-011 and revised the auto-build trigger wording from `nanogent start --docker` to `nanogent start`.
- **0.7 (2026-04-15)** — Added DR-013 (core and plugin installation are decoupled; plugins are self-describing, defaults are data). v0.10.0 shrinks `CORE_MANIFEST` to 9 non-pluggable files and moves the 7 default plugins out of `bin/cli.ts` and into a new `template/profiles/default.json` whose refs point at the vendored plugin dirs. Every plugin now ships a required `plugin.json` (name, type, optional description, optional files list); `readPluginManifest`, `resolvePlugin`, `loadProfile`, `installPlugin`, `listInstalledPlugins`, and `composeUpdateEntries` form a uniform plugin-lifecycle pipeline that third-party plugins and shipped defaults share. `nanogent init` runs in three phases (core copy → profile-driven plugin install → `runBuild` seed) and accepts `--profile <path>` for custom profiles. A new `nanogent plugin list/add/remove` subcommand exposes the lifecycle to operators. `runUpdate` composes entries from `CORE_MANIFEST` + installed-plugin discovery by default, preserving the existing code/plugin/config semantics. Deferred: git/npm plugin refs and a plugin lock file. `bin/cli.ts` no longer contains any plugin-name string literals.
- **0.8 (2026-04-15)** — Added DR-014 (minimal core↔plugin coupling) and DR-015 (portable state via per-type data contracts). Rewrote DR-010 as a reversal of the v0.7.0 scheduler-plugin design: the typed `SchedulerPlugin` seam is gone, time-based proactive triggers now live inside `tools/schedule` via an optional `ToolPlugin.start(ctx)` lifecycle hook returning a stop fn, and the `ToolStartCtx` hands plugins `pluginDir` + a `fireSystemTurn` primitive. `fireSystemTurn` is un-exported from `nanogent.ts` — plugins reach it only through ctx. `HistoryStoreCtx` and `MemoryCtx` drop their `stateDir` field: plugins now write state under `pluginDir/state/`, matching the convention `tools/claude` already used since v0.8.0. The plugin-type table drops from six rows to five (`scheduler/<name>/` is gone; `tools`, `channels`, `providers`, `history`, `memory` remain). DR-015 ships as principle-only in v0.11.0 — the `Portable<T>` interface, `export`/`import` methods on history, and `nanogent plugin migrate` / `export` / `import` CLI verbs are deferred to v0.12.0 but the principle influences v0.11.0's data layout (schedule definitions and execution log stay in separate files so future `export()` can dump the portable half cleanly).

When adding a new decision or updating an existing one, add a line here with the date and a one-sentence summary.
