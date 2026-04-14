// anthropic provider — one round-trip wrapper over Anthropic's Messages API.
//
// The core's chat-agent loop (nanogent.mjs) calls `chat(...)` once per model
// response and handles the tool-use loop itself. This plugin just translates
// between core's Anthropic-shaped canonical format and the actual HTTP API.
// Raw fetch — no SDK dependency.

const API_URL = 'https://api.anthropic.com/v1/messages';

function apiKey() {
  // Read from process.env at call time so re-reading .env across restarts works.
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('anthropic provider: missing ANTHROPIC_API_KEY');
  return key;
}

export default {
  name: 'anthropic',

  /**
   * Make one chat round-trip.
   *
   * Input (Anthropic-canonical shape):
   *   system:    Array<{ type: 'text', text, cache_control? }>
   *   messages:  Array<{ role: 'user' | 'assistant', content: string | Array<block> }>
   *   tools:     Array<{ name, description, input_schema, cache_control? }>
   *   model:     string
   *   maxTokens: number
   *
   * Output (normalised):
   *   { stopReason, content, usage }
   */
  async chat({ system, messages, tools, model, maxTokens }) {
    const body = {
      model,
      max_tokens: maxTokens,
      system,
      messages,
      tools,
    };

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type':     'application/json',
        'x-api-key':        apiKey(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`anthropic ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();

    return {
      stopReason: data.stop_reason,
      content:    data.content,
      usage: {
        inputTokens:          data.usage?.input_tokens ?? 0,
        outputTokens:         data.usage?.output_tokens ?? 0,
        cacheReadTokens:      data.usage?.cache_read_input_tokens ?? 0,
        cacheCreationTokens:  data.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  },
};
