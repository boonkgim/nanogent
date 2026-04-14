# memory/naive

Default memory plugin for nanogent. No vectors, no graphs, no summarisation
— just the last N messages from the history store, with boundary-aware
rotation so we never hand the LLM an orphan `tool_result`.

If you want something smarter — vector RAG, GraphRAG, mem0-style episodic
memory, summary memories, entity extraction — drop a new plugin under
`.nanogent/memory/<name>/` and delete this folder. Exactly one memory plugin
must be active per install.

## What "naive" means

On every turn:
1. Core calls `memory.recall(contactId, latestUserText)`.
2. This plugin reads the last `window * 2` messages from the history store.
3. Applies `rotateHistory` to trim to `window`, skipping forward past any
   orphan `tool_result` at the head.
4. Returns `{ messages }` — no `systemContext`.

On append/retract/clear, this plugin is a no-op. It doesn't maintain an
index — the history store **is** the index.

## Configuration

Window size defaults to `80` messages. Override via env:

```bash
NANOGENT_MEMORY_WINDOW=200 nanogent start
```

For v0.4.x users: this replaces the old `maxHistory` knob. The semantics
are identical — the rotation logic is the same code, it just lives in a
plugin now.

## Contract

Implements `MemoryPlugin` from `../../types.d.ts`. The core owns the
`contactId` string; this plugin treats it as opaque.

## When to replace this

Naive memory is the right choice when:
- Your conversations fit in a single-LLM context window
- Turn latency matters more than long-term recall
- You're not running at scale (tens of contacts, not tens of thousands)

Swap it for something else when:
- You want the agent to remember facts from conversations weeks ago
- You want per-contact summarisation to compress long histories
- You want to pull in structured context (user profile, project state,
  retrieved documents) into every turn via `systemContext`
- You're integrating with an external memory service (mem0, Letta,
  MemGPT, LangChain memory, etc.)

## Writing a smarter memory plugin

See [DESIGN.md DR-009b](../../../DESIGN.md) for the full contract and
design rationale. The short version:

```ts
import type { MemoryPlugin } from '../../types.d.ts';

const plugin: MemoryPlugin = {
  name: 'my-rag',

  async init(ctx) {
    // ctx.history — read access to the raw history store
    // ctx.stateDir — nanogent state dir (namespace your index here)
    // ctx.pluginDir — your own plugin folder on disk
  },

  async recall(contactId, query) {
    // retrieve relevant past turns + build a systemContext string
    return {
      messages: [/* short recent window */],
      systemContext: 'Relevant past excerpts:\n- ...',
    };
  },

  async onAppend(contactId, messages) {
    // embed + store each new message in your index
  },

  async onRetract(contactId, count) {
    // remove the last N entries you indexed
  },

  async onClear(contactId) {
    // wipe your index for this contact
  },
};

export default plugin;
```

## Cache-control gotcha

Anthropic prompt caching keys off the system prompt bytes. If your
`systemContext` changes every turn (it will for most RAG memories), you'll
invalidate the cache on every call. The core places `systemContext` **after**
the cached base prompt to minimise damage, but you should still structure
your retrieval so that stable context (entity facts, project state) and
volatile context (per-query excerpts) are clearly separated in the string.
A plugin author who cares about caching can return a deterministic prefix
followed by the volatile part.

## See also

- [../../history/jsonl/README.md](../../history/jsonl/README.md) — the
  default history store this plugin reads from.
- [DESIGN.md DR-009b](../../../DESIGN.md) — why memory is separate from
  history and why there's exactly one active.
