# telegram channel

Default nanogent channel. Long-polls the Telegram Bot API and emits normalised messages to the core.

## What it does

- Polls `getUpdates` with a 30-second long-poll timeout
- For each incoming text message: checks the core's contact config via `ctx.getChatConfig`, filters by the chat's `mode` field (`always` | `mention`), and forwards qualifying messages via `ctx.onMessage`
- Exposes `sendMessage(chatId, text)` and `editMessage(chatId, handle, text)` so the core (and tools) can reply

## Setup

- Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
- Put the token in `.nanogent/.env` as `TELEGRAM_BOT_TOKEN=...`
- Add at least one entry to `.nanogent/contacts.json` listing your chat ID. Find your chat ID by messaging [@userinfobot](https://t.me/userinfobot).

No other configuration required.

## `chatId` strategy

This plugin uses **Telegram's native `chat.id`** (the numeric value returned in every update's `message.chat.id`) as the `chatId`. This matches Telegram's native conversation model:

- **DM**: `chat.id` is the user's personal chat, unique per user
- **Group / supergroup**: `chat.id` is the group (negative integer), shared by all members
- **Channel**: `chat.id` is the broadcast channel (not supported by this plugin for now)

History for group chats is shared among all participants — that's the correct semantic for group conversations (see [DESIGN.md § DR-002](../../../DESIGN.md#dr-002-historymode--shared-vs-per-user)).

## Mention filtering

When a chat's `mode` is set to `"mention"` in `contacts.json`, this plugin only forwards messages that are either:

1. **An explicit mention of the bot** via `@bot_username` in the message text (parsed from Telegram's `entities` array of type `mention`)
2. **A reply to one of the bot's own messages** (checked via `reply_to_message.from.id`)
3. A `text_mention` entity linking to the bot user ID (hover-card mentions without a username)

All other messages in the chat are silently ignored at the plugin level — they never reach the core, never enter history, never burn tokens.

When `mode` is `"always"` (the default for DMs), the plugin forwards every text message from the chat without any mention checks.

The plugin calls Telegram's `getMe` at startup to discover its own `username` and `id`, which it uses to recognise mentions and replies-to-self.

## Supported message types

This plugin currently handles:

- Text messages (`message.text`) in DMs, groups, and supergroups
- Replies to previous messages (for reply-detection in mention mode)

Not handled (messages are silently ignored):

- Photos, videos, voice messages, files, stickers, polls, locations
- Inline queries
- Callback queries (button presses)
- Channel broadcasts
- Edited messages
- Bot commands (`/command` style — they arrive as regular text but nothing special is done with them)

Future plugin versions may handle more.

## User display names

For each forwarded message, the plugin emits `user.displayName` using this precedence:

1. `from.first_name` + `from.last_name` (joined, trimmed)
2. `@from.username` if no first/last name
3. `undefined` (the core will fall back to `user:<id>`)

Operators can override display names in `contacts.json > users > <name>.displayName` — those take precedence over the plugin's provided name.

## Rate limits

Telegram enforces rate limits on outgoing messages (roughly 30 messages/second globally, 1 message/second per chat, 20 messages/minute per group). The plugin does NOT implement throttling — tools that stream output should throttle their own `editMessage` calls (the `claude` tool does this at ~1.2s per edit).

Future plugin versions may add automatic throttling.

## Replacing this plugin

Write a different channel plugin in `.nanogent/channels/<name>/index.mjs` following the same contract:

```js
export default {
  name: '<your-name>',
  async start(ctx) { /* long-running listener; return a stop function */ },
  async sendMessage(chatId, text) { /* returns a message handle */ },
  async editMessage(chatId, handle, text) {},
};
```

See [DESIGN.md § DR-001](../../../DESIGN.md#dr-001-chatid-granularity-is-a-plugin-decision) for guidance on picking a `chatId` strategy, and [DR-008](../../../DESIGN.md#dr-008-group-chats-require-per-chat-mode-field-for-mention-filtering) for mention-filtering expectations.

You can run multiple channel plugins simultaneously — nanogent loads every `.nanogent/channels/<name>/index.mjs` and starts each one. Drop a new plugin in alongside this one, no core changes required.

## Removing it

```bash
rm -rf .nanogent/channels/telegram
```

But then there are no channels at all — the core requires at least one active channel to do anything useful, so add another before restarting.
