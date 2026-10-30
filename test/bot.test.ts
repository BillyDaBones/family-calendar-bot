import { beforeEach, describe, expect, test } from "bun:test";
import { Bot } from "../src/bot";
import { NONE, type Brain, type BrainInput, type Decision } from "../src/brain";
import type { CalendarApi, CalendarEvent } from "../src/calendar";
import type { Member } from "../src/config";
import type { Incoming, QuoteRef, Sender } from "../src/signal";
import { Store } from "../src/store";
import type { Judgments, Triage, TriageInput } from "../src/triage";

const BILLY = "+15550000001";
const JOHNNY = "+15550000002";
const members: Member[] = [
  { name: "Billy", number: BILLY, email: "billy@example.com", invites: true },
  { name: "Johnny", number: JOHNNY, email: "johnny@example.com", invites: true },
  { name: "Grandma", number: "+15550000003", email: "grandma@example.com", invites: false },
];

class FakeBrain implements Brain {
  next: Partial<Decision> = {};
  inputs: BrainInput[] = [];
  async decide(input: BrainInput): Promise<Decision> {
    this.inputs.push(input);
    return { ...NONE, ...this.next };
  }
  roasted: string[] = [];
  async roast(message: { authorName: string; text: string }) {
    this.roasted.push(message.text);
    return `Wow, "${message.text}". Riveting.`;
  }
}

class FakeCalendar implements CalendarApi {
  events = new Map<string, { event: CalendarEvent; attendees: string[] }>();
  notified: string[] = [];
  private n = 0;
  async create(event: CalendarEvent, attendees: string[]) {
    const id = `g${++this.n}`;
    this.events.set(id, { event, attendees });
    return id;
  }
  async update(id: string, event: CalendarEvent, notify: boolean) {
    this.events.get(id)!.event = event;
    if (notify) this.notified.push(id);
  }
  async cancel(id: string) {
    this.events.delete(id);
  }
}

class FakeSignal implements Sender {
  sent: { text: string; quote?: QuoteRef; ts: number }[] = [];
  private ts = 9_000_000;
  async send(text: string, quote?: QuoteRef) {
    const ts = ++this.ts;
    this.sent.push({ text, quote, ts });
    return ts;
  }
  direct: { number: string; text: string }[] = [];
  async sendDirect(number: string, text: string) {
    this.direct.push({ number, text });
  }
  get last() {
    return this.sent.at(-1)!;
  }
}

let brain: FakeBrain, calendar: FakeCalendar, signal: FakeSignal, store: Store, bot: Bot;
let ts = 1000;

function msg(text: string, extra: Partial<Incoming> = {}): Incoming {
  return { kind: "message", ts: ++ts, author: JOHNNY, authorName: "Johnny", text, ...extra };
}

beforeEach(() => {
  brain = new FakeBrain();
  calendar = new FakeCalendar();
  signal = new FakeSignal();
  store = new Store(":memory:");
  bot = new Bot({
    store,
    brain,
    calendar,
    signal,
    members,
    ownNumber: BILLY,
    timezone: "America/New_York",
    clock: () => new Date("2026-10-26T16:00:00Z"),
  });
});

async function createThanksgiving() {
  brain.next = { action: "create", title: "Thanksgiving at Mom's", start: "2026-11-26T14:00", all_day: false, location: "Mom's house" };
  const m = msg("Thanksgiving at Mom's on the 26th at 2");
  await bot.handle(m);
  return { source: m, confirmation: signal.last };
}

describe("Bot", () => {
  test("creates an event and invites people who want invites", async () => {
    const { confirmation } = await createThanksgiving();
    const [stored] = [...calendar.events.values()];
    expect(stored!.event.start).toBe("2026-11-26T14:00");
    expect(stored!.attendees).toEqual(["billy@example.com", "johnny@example.com"]);
    expect(confirmation.text).toBe(
      "📅 Added: Thanksgiving at Mom's\nThu, Nov 26 · 2:00 PM · Mom's house\nInvites sent to Billy, Johnny",
    );
  });

  test("omits the invite line when nobody gets invites", async () => {
    bot = new Bot({ store, brain, calendar, signal, members: members.map((m) => ({ ...m, invites: false })), ownNumber: BILLY, timezone: "America/New_York" });
    await createThanksgiving();
    expect(signal.last.text).not.toContain("Invites");
  });

  test("appends a follow-up detail without emailing invitees", async () => {
    await createThanksgiving();
    brain.next = { action: "add_detail", event_id: 1, detail: "bring folding chairs" };
    await bot.handle(msg("bring folding chairs"));
    const { event } = calendar.events.get("g1")!;
    expect(event.description).toContain("• bring folding chairs — Johnny, Mon, Oct 26");
    expect(calendar.notified).toEqual([]);
    expect(signal.last.text).toBe("📅 Added to Thanksgiving at Mom's: bring folding chairs");
  });

  test("a reply to the bot's confirmation is linked to that event", async () => {
    const { confirmation } = await createThanksgiving();
    brain.next = { action: "update", start: "2026-11-26T15:00", all_day: false };
    await bot.handle(msg("make it 3", { quote: { ts: confirmation.ts, author: BILLY, text: confirmation.text } }));
    expect(brain.inputs.at(-1)!.linkedEvent?.id).toBe(1);
    expect(calendar.events.get("g1")!.event.start).toBe("2026-11-26T15:00");
    expect(calendar.notified).toEqual(["g1"]);
    expect(signal.last.text).toBe("📅 Updated: Thanksgiving at Mom's\nThu, Nov 26 · 3:00 PM · Mom's house");
  });

  test("editing the original message updates instead of duplicating", async () => {
    const { source } = await createThanksgiving();
    brain.next = { action: "update", start: "2026-11-27T14:00", all_day: false };
    await bot.handle({ ...source, kind: "edit", text: "Thanksgiving at Mom's on the 27th at 2" });
    expect(brain.inputs.at(-1)!.linkedEvent?.id).toBe(1);
    expect(calendar.events.size).toBe(1);
    expect(calendar.events.get("g1")!.event.start).toBe("2026-11-27T14:00");
  });

  test("cancels an event", async () => {
    await createThanksgiving();
    brain.next = { action: "cancel", event_id: 1 };
    await bot.handle(msg("Thanksgiving is off"));
    expect(calendar.events.size).toBe(0);
    expect(store.getEvent(1)!.status).toBe("cancelled");
    expect(signal.last.text).toBe("📅 Cancelled: Thanksgiving at Mom's (Thu, Nov 26 · 2:00 PM)\nInvitees were notified.");
  });

  test("off-topic chatter creates nothing", async () => {
    await bot.handle(msg("lol did you see the game"));
    expect(calendar.events.size).toBe(0);
    expect(signal.sent).toEqual([]);
  });

  test("asks when unclear, then creates from the answer", async () => {
    brain.next = { action: "ask", question: "Which Friday, Oct 30 or Nov 6?" };
    const original = msg("dinner at Johnny's next Friday");
    await bot.handle(original);
    const question = signal.last;
    expect(question.text).toBe("📅 Which Friday, Oct 30 or Nov 6?");

    brain.next = { action: "create", title: "Dinner at Johnny's", start: "2026-11-06", all_day: true, question_id: question.ts };
    await bot.handle(msg("the 6th", { quote: { ts: question.ts, author: BILLY, text: question.text } }));
    expect(brain.inputs.at(-1)!.pending.map((p) => p.id)).toEqual([question.ts]);
    expect(calendar.events.get("g1")!.event.allDay).toBe(true);
    expect(store.openPending(0)).toEqual([]);
    // Editing the original message now maps to the new event.
    expect(store.linkedEvent(original.ts, JOHNNY)?.id).toBe(1);
  });

  test("ignores a create with an invalid date", async () => {
    brain.next = { action: "create", title: "Party", start: "next week", all_day: false };
    await bot.handle(msg("party next week"));
    expect(calendar.events.size).toBe(0);
  });

  test("!events lists the next 60 days", async () => {
    await createThanksgiving();
    await bot.handle(msg("!events"));
    expect(signal.last.text).toBe("📅 Next 60 days:\n• Thu, Nov 26 · 2:00 PM — Thanksgiving at Mom's");
    expect(brain.inputs.length).toBe(1);
  });

  test("ignores its own messages", async () => {
    await bot.handle(msg("📅 Added: something", { author: BILLY }));
    expect(brain.inputs.length).toBe(0);
  });

  test("reports calendar failures in the group", async () => {
    calendar.create = async () => {
      throw new Error("boom");
    };
    brain.next = { action: "create", title: "Party", start: "2026-11-01", all_day: true };
    await bot.handle(msg("party on the 1st"));
    expect(signal.last.text).toContain("couldn't update the calendar");
  });

  describe("triage", () => {
    const clearNo: Judgments = {
      announcesPlan: 0.02,
      changesPlan: 0.02,
      addsDetail: 0.02,
      cancelsPlan: 0.02,
      answersBot: null,
      asksAboutEvents: 0.05,
      asksHowToUseBot: 0.05,
    };
    let judgments: Judgments;
    let inputs: TriageInput[];

    beforeEach(() => {
      judgments = clearNo;
      inputs = [];
      const triage: Triage = {
        judge: async (input) => {
          inputs.push(input);
          return judgments;
        },
      };
      bot = new Bot({ store, brain, calendar, signal, members, ownNumber: BILLY, timezone: "America/New_York", triage, clock: () => new Date("2026-10-26T16:00:00Z") });
    });

    test("DMs a roast of the message to whoever posted it", async () => {
      await bot.handle(msg("lol"));
      expect(brain.roasted).toEqual(["lol"]);
      expect(signal.direct).toEqual([{ number: JOHNNY, text: '📅 Wow, "lol". Riveting.' }]);
      expect(signal.sent).toEqual([]);
    });

    test("roasts the bot account's own messages too", async () => {
      await bot.handle(msg("lol", { author: BILLY, authorName: "Billy" }));
      expect(signal.direct.map((d) => d.number)).toEqual([BILLY]);
    });

    test("falls back to a stock nudge when the roast fails", async () => {
      brain.roast = async () => {
        throw new Error("down");
      };
      await bot.handle(msg("lol"));
      expect(signal.direct[0]!.text).toMatch(/^📅 /);
    });

    test("DMs help to someone asking how to use the calendar", async () => {
      judgments = { ...clearNo, asksHowToUseBot: 0.95 };
      await bot.handle(msg("how do I add something?"));
      expect(signal.direct).toEqual([{ number: JOHNNY, text: expect.stringContaining("family calendar bot") }]);
      expect(signal.sent).toEqual([]);
    });

    test("DMs upcoming events to someone asking about them", async () => {
      await createThanksgiving();
      brain.next = {};
      judgments = { ...clearNo, asksAboutEvents: 0.95 };
      await bot.handle(msg("what time is thanksgiving?"));
      expect(signal.direct.at(-1)!.text).toContain("Thanksgiving at Mom's");
    });

    test("only runs when Claude chose none", async () => {
      await createThanksgiving();
      expect(inputs).toEqual([]);
    });

    test("leaves the message when Jev fails", async () => {
      bot = new Bot({ store, brain, calendar, signal, members, ownNumber: BILLY, timezone: "America/New_York", triage: { judge: async () => { throw new Error("down"); } } });
      await bot.handle(msg("lol", { author: BILLY }));
      expect(signal.sent).toEqual([]);
    });
  });
});
