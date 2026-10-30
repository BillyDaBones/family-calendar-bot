import type { Brain, Decision } from "./brain";
import type { CalendarApi, CalendarEvent } from "./calendar";
import type { Member } from "./config";
import type { Incoming, Sender } from "./signal";
import type { StoredEvent, Store } from "./store";
import { triageAction, type Triage } from "./triage";
import { addDays, formatDay, formatNow, formatWhen, isValidStart, nowLocal } from "./time";

export const PREFIX = "📅";
const RECENT_LIMIT = 12;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const HELP = `${PREFIX} I'm the family calendar bot. I keep the "Harris Family" Google Calendar in sync with this group.

• Mention a plan with a day: "Thanksgiving at Mom's on the 26th at 2". I'll add it and send invites.
• Add details later: "bring folding chairs". I'll put them on the event.
• Change it: reply to my message, or edit your original message.
• Cancel it: "Thanksgiving is off".
• !events lists the next 60 days.

Messages from me always start with ${PREFIX}. If I get something wrong, reply to my message to fix it, or edit the event in Google Calendar.`;

const NUDGES = [
  `${PREFIX} Fascinating. Truly. But the events group is for events. The family chat misses you.`,
  `${PREFIX} I checked, and that message has no date, no time and no plan. Bold choice for the events group.`,
  `${PREFIX} Love that for you. Now take it to the family chat, where it belongs.`,
  `${PREFIX} Quick reminder: the events group is for plans. I'm a calendar, not a group chat.`,
];

export interface BotDeps {
  store: Store;
  brain: Brain;
  calendar: CalendarApi;
  signal: Sender;
  members: Member[];
  ownNumber: string;
  timezone: string;
  // Optional: without it, off-topic messages are left alone.
  triage?: Triage;
  clock?: () => Date;
}

export class Bot {
  // Recent group messages, kept in memory only, so Claude can follow the conversation.
  private recent: { authorName: string; text: string }[] = [];

  constructor(private deps: BotDeps) {}

  nameFor(number: string): string | undefined {
    return this.deps.members.find((m) => m.number === number)?.name;
  }

  private now(): string {
    return nowLocal(this.deps.timezone, this.deps.clock?.() ?? new Date());
  }

  private invitees(): Member[] {
    return this.deps.members.filter((m) => m.email && m.invites);
  }

  async handle(msg: Incoming): Promise<void> {
    if (msg.text.startsWith(PREFIX)) return;

    const command = msg.text.toLowerCase().split(/\s+/)[0];
    if (command === "!events") return this.listEvents(msg);
    if (command === "!help") return void (await this.reply(msg, HELP));

    try {
      await this.process(msg);
    } catch (err) {
      console.error("Failed to handle message", err);
      await this.reply(msg, `${PREFIX} I couldn't update the calendar just now. Please add or fix it in Google Calendar by hand.`).catch(() => {});
    } finally {
      this.recent.push({ authorName: msg.authorName, text: msg.kind === "edit" ? `(edited) ${msg.text}` : msg.text });
      if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    }
  }

  private reply(msg: Incoming, text: string): Promise<number> {
    return this.deps.signal.send(text, { ts: msg.ts, author: msg.author, text: msg.text });
  }

  private eventsText(): string {
    const today = this.now().slice(0, 10);
    const events = this.deps.store.eventsBetween(today, addDays(today, 60));
    return events.length
      ? [`${PREFIX} Next 60 days:`, ...events.map((e) => `• ${formatWhen(e.start, e.allDay)} — ${e.title}`)].join("\n")
      : `${PREFIX} Nothing on the calendar for the next 60 days.`;
  }

  private async listEvents(msg: Incoming): Promise<void> {
    await this.reply(msg, this.eventsText());
  }

  private async process(msg: Incoming): Promise<void> {
    const { store } = this.deps;
    const now = this.now();
    const today = now.slice(0, 10);

    const linkedEvent =
      msg.kind === "edit"
        ? store.linkedEvent(msg.ts, msg.author)
        : msg.quote
          ? store.linkedEvent(msg.quote.ts, msg.quote.author)
          : null;
    const pending = store.openPending(Date.now() - PENDING_TTL_MS);
    const upcoming = store.eventsBetween(today, addDays(today, 365));

    const decision = await this.deps.brain.decide({
      now: `${formatNow(now)} (${this.deps.timezone})`,
      message: { authorName: msg.authorName, text: msg.text, isEdit: msg.kind === "edit" },
      linkedEvent,
      quotedText: msg.quote?.text ?? null,
      upcoming,
      recent: this.recent,
      pending: pending.map((p) => ({
        id: p.botTs,
        question: p.question,
        originalText: p.originalText,
        authorName: this.nameFor(p.originalAuthor) ?? p.originalAuthor,
      })),
    });

    console.log(`Decision: ${decision.action}${decision.question_id !== null ? ` (answers question ${decision.question_id})` : ""}`);
    const question = pending.find((p) => p.botTs === decision.question_id);
    const target = decision.event_id !== null ? store.getEvent(decision.event_id) : linkedEvent;

    switch (decision.action) {
      case "none":
        return this.triageOffTopic(msg, upcoming, pending.map((p) => p.question));
      case "create":
        return this.create(msg, decision, question?.botTs ?? null);
      case "ask":
        return this.ask(msg, decision);
    }

    if (!target || target.status !== "active") {
      console.warn(`Ignoring ${decision.action}: no active event ${decision.event_id}`);
      return;
    }
    if (decision.action === "update") return this.update(msg, decision, target);
    if (decision.action === "add_detail") return this.addDetail(msg, decision, target, today);
    if (decision.action === "cancel") return this.cancel(msg, target);
  }

  private description(event: StoredEvent | { createdBy: string; notes: string }): string {
    const lines = [`Added by ${event.createdBy} in the Signal events group.`];
    if (event.notes) lines.push("", "Details:", event.notes);
    return lines.join("\n");
  }

  private toCalendar(e: Omit<StoredEvent, "id" | "status" | "gcalId">): CalendarEvent {
    return { title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, description: this.description(e) };
  }

  private async create(msg: Incoming, d: Decision, questionTs: number | null): Promise<void> {
    const { store, calendar, ownNumber } = this.deps;
    const allDay = d.all_day ?? d.start?.length === 10;
    if (!d.title || !d.start || !isValidStart(d.start, allDay)) {
      console.warn("Ignoring create with missing or invalid title/start", d);
      return;
    }
    const end = d.end && isValidStart(d.end, allDay) && d.end > d.start ? d.end : null;
    const draft = { title: d.title, start: d.start, end, allDay, location: d.location, notes: "", createdBy: msg.authorName };

    const invitees = this.invitees();
    const gcalId = await calendar.create(this.toCalendar(draft), invitees.map((m) => m.email!));
    const event = store.insertEvent({ ...draft, gcalId });
    store.link(msg.ts, msg.author, event.id, "source");

    if (questionTs !== null) {
      const pending = store.openPending(0).find((p) => p.botTs === questionTs);
      if (pending) store.link(pending.originalTs, pending.originalAuthor, event.id, "source");
      store.removePending(questionTs);
    }

    const lines = [`${PREFIX} Added: ${event.title}`, this.whenWhere(event)];
    if (invitees.length) lines.push(`Invites sent to ${invitees.map((m) => m.name).join(", ")}`);
    const botTs = await this.reply(msg, lines.join("\n"));
    store.link(botTs, ownNumber, event.id, "bot");
  }

  private async update(msg: Incoming, d: Decision, event: StoredEvent): Promise<void> {
    const { store, calendar, ownNumber } = this.deps;
    const next = { ...event };
    if (d.title) next.title = d.title;
    if (d.location) next.location = d.location;
    if (d.start) {
      next.allDay = d.all_day ?? d.start.length === 10;
      next.start = d.start;
      next.end = null;
    }
    if (d.end) next.end = d.end;
    if (!isValidStart(next.start, next.allDay)) {
      console.warn("Ignoring update with invalid start", d);
      return;
    }
    if (next.end && (!isValidStart(next.end, next.allDay) || next.end <= next.start)) next.end = null;

    await calendar.update(event.gcalId, this.toCalendar(next), true);
    store.updateEvent(next);
    if (msg.kind !== "edit") store.link(msg.ts, msg.author, event.id, "update");

    const botTs = await this.reply(msg, `${PREFIX} Updated: ${next.title}\n${this.whenWhere(next)}`);
    store.link(botTs, ownNumber, event.id, "bot");
  }

  private async addDetail(msg: Incoming, d: Decision, event: StoredEvent, today: string): Promise<void> {
    const { store, calendar, ownNumber } = this.deps;
    const detail = d.detail?.trim() || msg.text;
    const line = `• ${detail} — ${msg.authorName}, ${formatDay(today)}`;
    const next = { ...event, notes: event.notes ? `${event.notes}\n${line}` : line };

    // Details don't email invitees; they show up on the event.
    await calendar.update(event.gcalId, this.toCalendar(next), false);
    store.updateEvent(next);
    store.link(msg.ts, msg.author, event.id, "detail");

    const botTs = await this.reply(msg, `${PREFIX} Added to ${event.title}: ${detail}`);
    store.link(botTs, ownNumber, event.id, "bot");
  }

  private async cancel(msg: Incoming, event: StoredEvent): Promise<void> {
    const { store, calendar } = this.deps;
    await calendar.cancel(event.gcalId);
    store.updateEvent({ ...event, status: "cancelled" });
    const lines = [`${PREFIX} Cancelled: ${event.title} (${formatWhen(event.start, event.allDay)})`];
    if (this.invitees().length) lines.push("Invitees were notified.");
    await this.reply(msg, lines.join("\n"));
  }

  // A message Claude didn't act on: Jev judges whether it's about events, and the bot either
  // leaves it, DMs the author an answer, or deletes it from the group.
  private async triageOffTopic(msg: Incoming, upcoming: StoredEvent[], pendingQuestions: string[]): Promise<void> {
    const { triage, signal, ownNumber } = this.deps;
    if (!triage || msg.kind === "edit") return;

    let action;
    try {
      const judgments = await triage.judge({ message: { authorName: msg.authorName, text: msg.text }, recent: this.recent, upcoming, pendingQuestions });
      action = triageAction(judgments);
      console.log(`Triage: ${action}`, judgments);
    } catch (err) {
      // A failed call is not an answer: leave the message alone.
      console.error("Triage failed; leaving message", err);
      return;
    }

    if (action === "dm_help") return signal.sendDirect(msg.author, HELP);
    if (action === "dm_events") return signal.sendDirect(msg.author, `${this.eventsText()}\n\nSend !help to see what I can do.`);
    if (action === "delete") {
      // Signal only lets an account delete its own messages, so everyone else gets a nudge.
      if (msg.author !== ownNumber) return signal.sendDirect(msg.author, NUDGES[msg.ts % NUDGES.length]!);
      await signal.remoteDelete(msg.ts);
    }
  }

  private async ask(msg: Incoming, d: Decision): Promise<void> {
    if (!d.question) return;
    const botTs = await this.reply(msg, `${PREFIX} ${d.question}`);
    this.deps.store.addPending({
      botTs,
      question: d.question,
      originalText: msg.text,
      originalAuthor: msg.author,
      originalTs: msg.ts,
      createdAt: Date.now(),
    });
  }

  private whenWhere(e: Pick<StoredEvent, "start" | "allDay" | "location">): string {
    const when = formatWhen(e.start, e.allDay);
    return e.location ? `${when} · ${e.location}` : when;
  }
}
