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
- **v0.7.0** — Scheduler introduced as an optional (zero-or-one) plugin type. Time-based proactive triggers are now a first-class concern: the agent manages schedules conversationally via the bundled `schedule` tool, a core tick loop fires due schedules through the shared `fireSystemTurn` entry point, and execution state is stored as an append-only log separate from the rules file. See [DR-010](#dr-010-scheduler-is-an-optional-pluggable-proactive-trigger-source).
- **v0.8.0** — Container dependencies made pluggable. The core `Dockerfile` becomes a base stub with a marker line; each plugin can ship an optional `install.sh` next to its `index.ts`, and a new `nanogent build` CLI command composes the real `Dockerfile.generated` by splicing every plugin's install step into the base. The `@anthropic-ai/claude-code` install moves out of core and into `tools/claude/install.sh` — swapping in a different coding harness (e.g. `tools/opencode/`) no longer requires editing the core Dockerfile. See [DR-011](#dr-011-plugins-inject-container-dependencies-via-installsh).
- **v0.9.0** — Docker becomes the only supported runtime. The host-node path, the `--node` / `--docker` start flags, and the `docker` field in `config.json` are removed. Rationale: plugin `install.sh` scripts can run `apt-get`, `npm install -g`, and write to system paths, so running them on the host is exactly the pollution Docker was added to prevent. Making Docker mandatory eliminates a dual-install contract (host vs container) and collapses the test matrix to one runtime. See [DR-012](#dr-012-docker-is-the-only-supported-runtime).

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
  state/              — core runtime state (jobs, learnings; history and schedules live under their plugins' control but under this dir)
  tools/<name>/       — plugin tools (many active)                    [v0.3.1+]
  channels/<name>/    — plugin channels (many active)                 [v0.4.0]
  providers/<name>/   — plugin AI providers (exactly one active)      [v0.4.0]
  history/<name>/     — plugin history store  (exactly one active)    [v0.5.0]
  memory/<name>/      — plugin memory system  (exactly one active)    [v0.5.0]
  scheduler/<name>/   — plugin scheduler     (zero or one active)     [v0.7.0]
```

Six plugin directories, six extensibility points:

| Plugin type | Directory | How many active? | What it does | Status |
|---|---|---|---|---|
| **Tool** | `tools/<name>/` | Many | Exposes a capability to the chat agent (`claude`, `rag`, `search`, `schedule`, ...) | Implemented (v0.3.1) |
| **Channel** | `channels/<name>/` | Many | Handles a transport (`telegram`, `whatsapp`, `email`, ...) | Implemented (v0.4.0) |
| **Provider** | `providers/<name>/` | Exactly one | Implements the AI chat loop (`anthropic`, `openai`, ...) | Implemented (v0.4.0) |
| **History store** | `history/<name>/` | Exactly one | Raw append-only message log (`jsonl`, `postgres`, ...) | Implemented (v0.5.0) |
| **Memory** | `memory/<name>/` | Exactly one | Indexer + retriever over history (`naive`, `vector-rag`, `graphrag`, ...) | Implemented (v0.5.0) |
| **Scheduler** | `scheduler/<name>/` | Zero or one | Stores schedule definitions + execution log; core tick fires due jobs (`jsonl`, `pg-boss`, ...) | Implemented (v0.7.0) |

The asymmetry in "how many active" reflects real differences:
- **Tools are capabilities** — a project can have several (coding, RAG, search, calendar, schedule)
- **Channels are ingress points** — a project can have several (DM via Telegram, email, group on WhatsApp)
- **Providers are thinking layers** — a chat agent has one reasoning model per turn; multiplexing two providers within one conversation is confused, not a feature
- **History is the source of truth** — one canonical log per install; multiple stores would split the truth
- **Memory is a single lens** — the agent reasons from one context model at a time; two memories would disagree on what's relevant
- **Scheduler is optional** — many projects never need proactive triggers. Zero is a valid state (no tick loop runs, the bundled `schedule` tool returns a clear error). One is enough — two would race on claim semantics and produce double-fires

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

### DR-010: Scheduler is an optional pluggable proactive trigger source

**What.** Schedules (time-based proactive triggers) are handled by an optional **scheduler plugin** under `.nanogent/scheduler/<name>/`. Zero or one scheduler is active per install — unlike history/memory, the runtime does not require a scheduler, and projects that don't need proactivity simply don't install one.

The scheduler plugin owns both schedule **definitions** (the rules the agent set up) and the **execution log** (what actually fired, when, with what status). The contract:

```ts
interface SchedulerPlugin {
  init(ctx): Promise<void>;

  // Definition CRUD — called by the agent-facing `schedule` tool
  createSchedule(spec): Promise<Schedule>;
  listSchedules(filter?): Promise<Schedule[]>;
  getSchedule(id): Promise<Schedule | null>;
  deleteSchedule(id): Promise<boolean>;

  // Execution — called by the core tick loop (once a minute)
  claimDue(now, limit?): Promise<ClaimedJob[]>;
  markComplete(jobId): Promise<void>;
  markFailed(jobId, error): Promise<void>;

  // Introspection
  listExecutions(filter?): Promise<ScheduleExecution[]>;
}
```

The bundled default (`scheduler/jsonl`) stores definitions in `state/schedules.json` and execution state in `state/schedule-log.jsonl` (append-only). Alternative backends (sqlite, pg-boss, redis, cloud cron bridges) can swap in without changing core or the agent-facing tool.

Core owns three small pieces of plumbing that go with the plugin:

1. A **`fireSystemTurn(channel, chatId, contactId, text)` helper** — the single entry point for turns that weren't initiated by a user message. It builds a synthetic trigger and injects it into the existing turn queue with `isSystemTrigger: true`, so the turn goes through the same memory recall → tool loop → channel send pipeline as any other turn. The scheduler tick loop uses it; the existing async-job completion path (pre-v0.7.0) already does the equivalent inline, and future event sources (webhooks, tool completion callbacks) should route through the same helper.

2. A **scheduler tick loop** — `setInterval(60_000)` that calls `scheduler.claimDue(new Date(), 10)`, fans each returned job into `fireSystemTurn`, then calls `markComplete` (or `markFailed` if enqueueing threw). The loop is started only if a scheduler plugin is loaded; it is a no-op otherwise. One tick fires immediately on boot so schedules that came due while the process was down get picked up right away (subject to the plugin's own missed-fire policy).

3. A **`scheduler` field on `ToolCtx`** — so the bundled `schedule` tool (and any future scheduling-aware tool) can reach the active plugin via `ctx.scheduler`. Null if no scheduler is installed.

**Why.**

- **Proactivity is real demand, plugin shape is speculative.** Many nanogent deployments want "run this at 8am" — that's a concrete use case. But "how should the schedule queue work" has genuine implementation variance: in-process jsonl, sqlite, durable queues like pg-boss, external cron bridges. Hardcoding one choice would either ship over-engineered defaults or box in users who need durability guarantees. A plugin seam lets the default be as simple as jsonl while leaving the door open for substitution. Designing the contract from core's actual call sites (CRUD + claim/complete/fail) kept the interface to ten methods — small enough to be worth having, large enough to be meaningful.

- **Definitions and execution state are tightly coupled.** Unlike history/memory (where memory is a *derived projection* that can legitimately be swapped independently), a scheduler's rules and its execution log always ship together: a sqlite scheduler wants both in the same db file, a redis scheduler wants both in the same keyspace, and swapping one without the other would leave orphan claims or unresolvable references. So scheduler is **one plugin**, not two (`schedule-store` + `schedule-queue`) — splitting them would be speculative pluggability nobody would use.

- **The definitions file is a clean source of truth; per-fire state is append-only.** Inside the default jsonl plugin, `state/schedules.json` holds only the rules (what the agent CRUDs), and `state/schedule-log.jsonl` holds every fire attempt (claimed / completed / failed). This mirrors the event-sourcing shape already used for history/memory: the definitions file changes only on explicit CRUD, the log grows monotonically as schedules fire. Retry policy, last-fired tracking, and execution history all derive from the log without mutating the rules file.

- **Zero is a valid state.** Requiring a scheduler would force every nanogent install to ship one — wasted bytes for projects that never use proactivity. Making it optional lets operators opt in by dropping `scheduler/jsonl/` into `.nanogent/` (which `nanogent init` does by default, but `nanogent update` respects the user's choice if they remove it).

- **Agent-initiated, not config-file-initiated.** Schedules are conversational: "remind me every morning at 8". That implies the agent creates them through a tool call rather than the operator editing config files from a terminal. Schedule state therefore lives under `state/` (mutable runtime state the agent owns), not `config.json` (operator-owned). This matches how history files are handled — same category of data.

- **The scheduler plugin is NOT the right primitive for user-initiated turns or async tool dispatch.** Both tempting unifications are wrong. Routing user messages through the scheduler queue would add latency to the conversational hot path for no benefit. Routing async tool jobs through the scheduler would conflate "this turn has background work" (a per-turn concern with ephemeral semantics) with "this schedule needs to fire later" (a persistent, restart-safe concern). The shared primitive is `fireSystemTurn`, not the scheduler — schedules, async tool completions, and future webhook events all *use* `fireSystemTurn` to inject a turn, but they don't share state, lifecycle, or retry semantics.

**Consequences.**

- **`claimDue` atomicity is the one semantically loaded operation.** The contract promise is: "a claimed job will not be returned by a second `claimDue` call until `markComplete` or `markFailed` runs." The jsonl default achieves this via a `claimed` log entry; a SQL backend would use `SELECT ... FOR UPDATE SKIP LOCKED`; a redis backend would use `BRPOPLPUSH`. Core doesn't care how — it just calls the method.

- **Orphan claim recovery is the plugin's responsibility.** If a previous process crashed between `claimed` and `markComplete`, the scheduleId could stay in "in-flight" forever. The jsonl default handles this on `init()` by scanning the log for orphan claims and fail-forwarding them with `error: orphan-crash-recovery`. Alternative backends must implement equivalent logic — the core doesn't retry, re-claim, or replay on its behalf.

- **Retry policy is plugin-scoped, not core-scoped.** Core does not retry failed fires. If a scheduler plugin wants retries (e.g., "if a turn fails, re-queue with exponential backoff"), it does so internally — its `markFailed` implementation can append a new due-at record and `claimDue` will pick it up on the next tick. The default jsonl plugin does **not** implement retries: a failed fire is recorded as `failed` and the schedule becomes eligible again on its next computed time. This is intentional — retrying a scheduled agent turn is semantically ambiguous (does the agent want to see "I'm retrying because the last run failed" in history, or should it be invisible?), and cheap to add per-backend when a real requirement appears.

- **Missed-fire policy is plugin-scoped.** If the process is down for two hours, a `daily@08:00` schedule that should have fired once during that window could be replayed on boot (once, to catch up) or silently dropped (treat the window as lost). The jsonl default fires it once on boot tick because computeNextFire returns a past time — which the tick loop treats as due. A durable backend might implement exactly-once semantics or sliding windows. Plugin authors should document their choice.

- **`fireSystemTurn` is the only new core export.** Everything else the scheduler plugin needs already exists: the turn queue, `processTrigger`'s `isSystemTrigger` branch that recomputes effective tools for non-user triggers, the channel send pipeline. The scheduler is a small addition precisely because the runtime already had the shape it needed.

- **System prompt contextualization is the agent's responsibility.** When a scheduled turn fires, the trigger text is prefixed `[SCHEDULED "<name>"] <prompt>` so the agent can recognize it's responding to a scheduled event rather than a live user message. Plugin authors writing alternative schedulers should preserve this prefix pattern or document their own convention — the agent relies on it to adjust tone and phrasing.

- **`schedule` tool is bundled but inert without a scheduler.** The agent-facing `schedule` tool ships as a default in `tools/schedule/` because scheduling is a common-enough capability that making it a first-class default beats making users hunt for it. If no scheduler plugin is installed, every call to the tool returns a clear error pointing at `.nanogent/scheduler/`. This matches the pattern of installing capability-first and letting operators disable what they don't want.

- **Time zones are punted to the agent.** The default jsonl scheduler stores `daily@HH:MM` in UTC. The agent is responsible for converting the user's local wall clock to UTC before calling `schedule_create`. A richer `daily@HH:MM@<tz>` format is a future extension that plugin authors can add independently.

- **Per-contact execution serialization is unchanged.** The existing global `turnQueue` already serializes all turns (user + system + scheduled) across the entire process, so scheduler fires cannot race with live user messages or async job completions. A future per-contact serializer (allowing cross-contact parallelism) would not change the scheduler — it still just enqueues via `fireSystemTurn`.

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

### Writing a scheduler plugin (v0.7.0+)

Read [DR-010](#dr-010-scheduler-is-an-optional-pluggable-proactive-trigger-source) first.

**Checklist:**

- [ ] Implement the full `SchedulerPlugin` contract: `init`, `createSchedule`, `listSchedules`, `getSchedule`, `deleteSchedule`, `claimDue`, `markComplete`, `markFailed`, `listExecutions`
- [ ] Honour the `claimDue` atomicity promise: a claimed job must not be returned by a second `claimDue` call until `markComplete` or `markFailed` has run. For jsonl, this means writing a `claimed` log entry synchronously before returning. For SQL, this means `SELECT ... FOR UPDATE SKIP LOCKED` or equivalent. For redis, `BRPOPLPUSH` or equivalent.
- [ ] Keep the definitions file (or equivalent table) and the execution log separate concerns in your backend. Definitions change only on CRUD; the log grows monotonically. Do not mutate an existing execution record to reflect a status change — append a new one. This matches event-sourcing semantics and makes restart recovery trivial.
- [ ] Implement orphan claim recovery on `init`. Scan your in-flight state for `claimed` records with no matching `completed`/`failed` and decide (a) fail-forward them with a descriptive error, or (b) re-issue them on the next `claimDue`. The default jsonl plugin fails them forward — document whichever choice you make.
- [ ] Document your schedule string format in your plugin's README. The bundled jsonl default supports `once@<ISO-UTC>`, `daily@HH:MM`, `every@<seconds>`. You are free to invent your own — cron expressions, natural-language intervals, calendar integrations — as long as the agent can generate valid strings from its system prompt or the tool description teaches the format.
- [ ] Reject invalid schedule strings eagerly in `createSchedule` (throw, don't silently store). A schedule that never fires because the format was wrong is a very frustrating failure mode to debug.
- [ ] `getSchedule`, `listSchedules`, `listExecutions` are read-only — do not mutate state in them.
- [ ] If you implement retries, implement them inside the plugin (e.g., `markFailed` re-enqueues the schedule with a delayed next-fire). Core does not retry. Document your retry policy in the README.
- [ ] Document your missed-fire policy: when the process was down through a scheduled time, do you fire once on boot (catch-up), drop silently, or replay every missed instance in order? The jsonl default fires once on boot.
- [ ] Keep plugin state under `ctx.stateDir` and do not hardcode paths outside it. The core's `/state/` gitignore covers this dir by default.
- [ ] Treat `contactId`, `channel`, and `chatId` on `ScheduleSpec` as opaque strings — they're routing metadata, not schedule identity. Do not parse them.
- [ ] Log failures but don't throw out of methods that the core calls in a tight loop (`claimDue` especially). A scheduler plugin that throws every tick will just spam logs; one that logs and returns an empty result degrades gracefully.

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
- **Build output is not a new plugin type.** It's a convention applied to existing plugin types. The six plugin-type extensibility points (tool, channel, provider, history, memory, scheduler) stay at six. Every plugin can opt in via `install.sh`; none have to.
- **The base Dockerfile is still customisable.** Operators who need a different FROM image, extra baseline apt packages, locale settings, or non-root users edit `.nanogent/Dockerfile` (which is `type: code` in the update manifest, so it's overwritten on update — re-apply local changes after `nanogent update`). The marker line must stay intact.
- **Resource requirements are surfaced as an advisory, not edited into compose.** `install.sh` only controls what's *installed* in the image; the actual `mem_limit` / `cpus` / GPU passthrough in `docker-compose.yml` stays operator-owned. As a v0.8.1 follow-up, plugins may optionally ship a `resources.json` next to `install.sh` declaring `minMemoryMb` / `minCpus` / `note`. `nanogent build` aggregates these across all plugins via `max()` (plugins share one container, so the floor is the hungriest plugin's floor — not the sum) and prints one advisory block at the end of the build, including which plugin set each max and whether `docker-compose.yml` already declares any resource limits. Missing, malformed, or partial `resources.json` files are fine: discovery warns and skips, and the build never fails on an advisory file. GPU passthrough remains out of scope — `resources.json` is advisory-only, no compose mutation, so it has nothing to declare about `device_requests` beyond a free-text `note`.

**Checklist for plugin authors adding an `install.sh`:**

- [ ] Place the file at `<plugin-root>/<name>/install.sh` next to `index.ts`
- [ ] Start with `#!/usr/bin/env bash` and `set -euo pipefail` — fail fast on install errors
- [ ] Keep it minimal and auditable — plugin operators will read this before trusting your plugin
- [ ] Prefer idempotent steps (`apt-get install -y` is already idempotent; guard vendor installers with `command -v X >/dev/null || ...` where possible)
- [ ] Do not rely on `.nanogent/` being present inside the image — the install script runs in a bare build context with only the script itself copied in. Any runtime files your plugin needs live under its plugin folder and are visible at runtime, not install time.
- [ ] Pin versions when stability matters (`npm install -g pkg@1.2.3`), accept latest only when the plugin author is willing to own the churn
- [ ] Do not write to plugin folders from `install.sh` — those files don't persist past the RUN layer, and state should live under `ctx.stateDir` at runtime anyway
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

When adding a new decision or updating an existing one, add a line here with the date and a one-sentence summary.
