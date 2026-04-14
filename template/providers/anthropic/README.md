# anthropic provider

Default nanogent AI provider. Wraps Anthropic's [Messages API](https://docs.anthropic.com/en/api/messages) as the chat agent's thinking layer.

## What it does

On each chat-agent turn, the core calls this plugin's `chat({ system, messages, tools, model, maxTokens })` exactly once. The plugin makes one HTTP round-trip to `https://api.anthropic.com/v1/messages` and returns a normalised response the core understands.

The core owns the tool-use loop — it calls `chat()` repeatedly, executes any tool calls, appends `tool_result` blocks to the message history, and calls `chat()` again until the model returns `stop_reason: end_turn`. The provider plugin is stateless between calls.

## Setup

- Requires an Anthropic API key. Get one at [console.anthropic.com](https://console.anthropic.com).
- Put it in `.nanogent/.env` as `ANTHROPIC_API_KEY=sk-ant-...`.
- No additional configuration needed.

## Model selection

The model to use is set in `.nanogent/config.json` under `chatModel`. Default: `claude-haiku-4-5` (cheap + fast, right for routing decisions). Override to `claude-sonnet-4-6` or `claude-opus-4-6` for smarter chat at higher cost:

```json
{
  "chatModel": "claude-sonnet-4-6"
}
```

## Prompt caching

The core marks the stable portions of the system prompt and the tool definitions with `cache_control: { type: 'ephemeral' }`. This plugin passes those markers through to the Anthropic API unchanged — Anthropic handles the caching natively.

Cache hits reduce input token cost by ~90% and improve latency. They apply to any request within ~5 minutes of a matching cache entry.

## Replacing this provider

If you want to use a different provider (OpenAI, local Ollama, Gemini, etc.), you have two options:

1. **Replace this folder**: write a new `providers/<name>/index.mjs` that default-exports `{ name, async chat(...) }` with the same contract, and remove `providers/anthropic/`. Only one provider can be active per install (v0.4.0+ enforces this).

2. **Wrap this provider**: if you want fallback or A/B routing across multiple backends, write a single plugin (e.g., `providers/multi/index.mjs`) that internally calls multiple backends. The core sees one provider.

The contract your replacement must satisfy:

```js
export default {
  name: '<your-provider-name>',
  async chat({ system, messages, tools, model, maxTokens }) {
    // 1. Translate the Anthropic-canonical input to your provider's native API.
    // 2. Make the round-trip.
    // 3. Translate the response back to { stopReason, content, usage }.
    //    Content blocks must be Anthropic-shaped ({ type: 'text', text } or
    //    { type: 'tool_use', id, name, input }) — the core's tool-use loop
    //    expects that shape.
    // 4. Honour cache_control markers if your provider supports caching.
  },
};
```

See [DESIGN.md § DR-005](../../../DESIGN.md#dr-005-permission-model--chat--user-intersection-no-tool-level-permissions) and the provider plugin guidance for details.

## Removing it

```bash
rm -rf .nanogent/providers/anthropic
```

But then there's no provider at all — the core requires exactly one active provider, so you must add another before starting. Missing provider = startup error.
