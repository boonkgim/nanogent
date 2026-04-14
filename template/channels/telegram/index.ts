// telegram channel plugin — long-polling Bot API listener.
//
// Emits normalised messages to the core via ctx.onMessage, and exposes
// sendMessage / editMessage so the core (and tools) can reply.
//
// chatId strategy: Telegram's native `chat.id` (numeric, stable per chat).
// - DMs: chat.id == user's personal chatId
// - Groups: chat.id is the group (negative integer), all members share
//
// mode filtering: implements both "always" and "mention".
// - always: forwards every text message from allowlisted chats
// - mention: forwards only messages that @-mention the bot OR are replies to
//   the bot's own messages. Requires knowing our bot username (fetched via
//   getMe at startup).

import type { ChannelPlugin, MessageHandle } from '../../types.d.ts';

const TELEGRAM_TIMEOUT_S = 30;
const MAX_MSG = 3900; // Telegram hard cap is 4096; leave headroom.

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('telegram channel: missing TELEGRAM_BOT_TOKEN');
  return t;
}

function api(method: string): string {
  return `https://api.telegram.org/bot${token()}/${method}`;
}

interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

async function call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<TelegramResponse<T>> {
  try {
    const r = await fetch(api(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json() as TelegramResponse<T>;
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || String(e) };
  }
}

function truncate(text: string): string {
  const s = String(text ?? '');
  return s.length > MAX_MSG ? s.slice(-MAX_MSG) : s;
}

interface TelegramFrom {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramFrom;
  chat: { id: number; type: string; title?: string };
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number; user?: TelegramFrom }>;
  reply_to_message?: { from?: TelegramFrom };
}

/**
 * Extract a display name from a Telegram `from` object.
 */
function displayNameFrom(from?: TelegramFrom): string | undefined {
  if (!from) return undefined;
  const first = from.first_name || '';
  const last  = from.last_name  || '';
  const name  = `${first} ${last}`.trim();
  if (name) return name;
  if (from.username) return `@${from.username}`;
  return undefined;
}

/**
 * Check whether a Telegram `message` object mentions the bot OR is a reply
 * to the bot's own message. Used for mode=mention filtering.
 */
function isAddressedToBot(message: TelegramMessage, botUsername: string, botUserId: number): boolean {
  // Reply-to-bot counts as addressed.
  const repliedFromId = message?.reply_to_message?.from?.id;
  if (repliedFromId && botUserId && String(repliedFromId) === String(botUserId)) {
    return true;
  }
  // Check entities for a @bot_name mention.
  const entities = message?.entities || [];
  const text = message?.text || '';
  for (const e of entities) {
    if (e.type === 'mention') {
      const mention = text.slice(e.offset, e.offset + e.length);
      if (mention.toLowerCase() === `@${botUsername}`.toLowerCase()) return true;
    } else if (e.type === 'text_mention') {
      if (e.user?.id && botUserId && String(e.user.id) === String(botUserId)) return true;
    }
  }
  return false;
}

const plugin: ChannelPlugin = {
  name: 'telegram',

  async start(ctx) {
    // Discover our own bot identity — needed for mention detection.
    const me = await call<{ username: string; id: number }>('getMe', {});
    if (!me?.ok || !me.result) {
      throw new Error(`telegram channel: getMe failed — ${JSON.stringify(me).slice(0, 200)}`);
    }
    const botUsername = me.result.username;
    const botUserId   = me.result.id;
    ctx.log(`started (@${botUsername}, id=${botUserId})`);

    let offset = 0;
    let running = true;

    // Long-poll loop runs forever until stop() is called.
    void (async () => {
      while (running) {
        const res = await call<Array<{ update_id: number; message?: TelegramMessage }>>(
          'getUpdates', { offset, timeout: TELEGRAM_TIMEOUT_S },
        );
        if (!res?.ok) {
          // Transient error — brief pause then retry so we don't hammer the API.
          ctx.log('getUpdates error', JSON.stringify(res).slice(0, 200));
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        const updates = res.result || [];
        for (const u of updates) {
          offset = u.update_id + 1;
          const m = u.message;
          if (!m?.text) continue;

          const chatId  = String(m.chat.id);
          const isGroup = m.chat.type === 'group' || m.chat.type === 'supergroup';

          // Allowlist + mode check via core-provided helper.
          const chat = ctx.getChatConfig('telegram', chatId);
          if (!chat) {
            ctx.log(`unknown chat dropped — chatId=${chatId} title="${m.chat.title || ''}" sender="${displayNameFrom(m.from) || ''}" preview="${(m.text || '').slice(0, 60)}"`);
            continue;
          }
          if (chat.enabled === false) continue;

          // Apply mode filtering for groups and mention-mode chats.
          if (chat.mode === 'mention') {
            if (!isAddressedToBot(m, botUsername, botUserId)) continue;
          }
          // mode=always → forward every text message; no filtering

          const user = {
            id:          String(m.from?.id || chatId), // fall back to chatId for 1:1
            displayName: displayNameFrom(m.from),
          };

          ctx.onMessage({
            channel: 'telegram',
            chatId,
            user,
            text: m.text,
            isGroup,
          });
        }
      }
    })().catch((e: Error) => { ctx.log('poll loop error', e?.message || e); });

    // Return the stop function the core will call on shutdown.
    return () => { running = false; };
  },

  /**
   * Send a new message to a chat. Returns an opaque message handle used by
   * editMessage later.
   */
  async sendMessage(chatId: string, text: string): Promise<MessageHandle | null> {
    const res = await call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text:    truncate(text),
    });
    if (!res?.ok || !res.result) return null;
    return { messageId: res.result.message_id };
  },

  /**
   * Edit a previously-sent message in place.
   */
  async editMessage(chatId: string, handle: MessageHandle | null, text: string): Promise<void> {
    if (!handle?.messageId) return;
    await call('editMessageText', {
      chat_id:    chatId,
      message_id: handle.messageId,
      text:       truncate(text),
    });
  },
};

export default plugin;
