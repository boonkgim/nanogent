// tools/schedule — agent-facing tool for managing proactive schedules.
//
// Exposes a single `schedule` tool with an `action` parameter that routes
// to the loaded scheduler plugin (see .nanogent/scheduler/<name>/). When the
// user says things like "remind me to review the PR at 6pm" or "every
// morning at 8 summarise yesterday's activity", the chat agent calls this
// tool with action=create. When the user asks "what reminders do I have
// set?", action=list. When they say "cancel the morning briefing",
// action=cancel.
//
// Delivery route (channel + chatId + contactId) is captured from the
// current turn's ToolCtx at creation time — the schedule fires back to the
// same conversation it was created in.

import type { ToolPlugin } from '../../types.d.ts';

const plugin: ToolPlugin = {
  name: 'schedule',
  description:
    'Manage proactive reminders/schedules for this conversation. Use this when the user asks you '
    + 'to do something later or on a recurring basis ("remind me every morning at 8", "run this at '
    + '6pm", "every hour check X"). The schedule fires as a synthetic turn in the same chat at the '
    + 'scheduled time, with the stored prompt as if the user had just asked it. '
    + 'Supported "when" formats (UTC): "once@2026-04-15T18:00:00Z" for one-shot, "daily@08:00" for '
    + 'every day at that UTC time, "every@3600" for every N seconds from creation. Convert the '
    + "user's local time to UTC before passing it in. Actions: create, list, cancel.",
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'cancel'],
        description:
          'What to do. "create" adds a new schedule. "list" shows existing schedules for this '
          + 'conversation. "cancel" deletes one by id (get the id from list first).',
      },
      name: {
        type: 'string',
        description: 'Short human-readable label for the schedule, e.g. "morning briefing". (create only)',
      },
      when: {
        type: 'string',
        description:
          'When the schedule should fire. Formats: "once@<ISO-UTC>" one-shot, "daily@HH:MM" every '
          + 'day at HH:MM UTC, "every@<seconds>" interval from creation. (create only)',
      },
      prompt: {
        type: 'string',
        description:
          'The instruction you will receive when this schedule fires. Write it as if the user '
          + 'were asking it fresh ("Summarise yesterday\'s activity"). Keep it self-contained — '
          + 'by the time it fires there may be no recent conversation context. (create only)',
      },
      id: {
        type: 'string',
        description: 'Schedule id to cancel (from a prior list call). (cancel only)',
      },
    },
    required: ['action'],
  },

  async execute(input, ctx) {
    if (!ctx.scheduler) {
      return 'error: no scheduler plugin is installed. Ask the operator to add one under .nanogent/scheduler/.';
    }
    const action = String(input.action || '').trim();

    if (action === 'list') {
      const schedules = await ctx.scheduler.listSchedules({ contactId: ctx.contactId });
      if (schedules.length === 0) return 'No schedules set for this conversation.';
      const lines = schedules.map(s =>
        `${s.id} — "${s.name}" (${s.schedule}) → ${s.prompt}`,
      );
      return lines.join('\n');
    }

    if (action === 'create') {
      const name   = typeof input.name === 'string' ? input.name.trim() : '';
      const when   = typeof input.when === 'string' ? input.when.trim() : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (!name || !when || !prompt) {
        return 'error: create requires name, when, and prompt';
      }
      try {
        const sched = await ctx.scheduler.createSchedule({
          name,
          schedule:  when,
          prompt,
          channel:   ctx.channel,
          chatId:    ctx.chatId,
          contactId: ctx.contactId,
        });
        return `Scheduled "${sched.name}" (id=${sched.id}) — will fire per ${sched.schedule}.`;
      } catch (e) {
        return `error: ${(e as Error)?.message || String(e)}`;
      }
    }

    if (action === 'cancel') {
      const id = typeof input.id === 'string' ? input.id.trim() : '';
      if (!id) return 'error: cancel requires id';
      const ok = await ctx.scheduler.deleteSchedule(id);
      return ok ? `Cancelled schedule ${id}.` : `No schedule found with id ${id}.`;
    }

    return `error: unknown action '${action}'. Valid: create, list, cancel.`;
  },
};

export default plugin;
