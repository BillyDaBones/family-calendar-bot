import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { StoredEvent } from "./store";
import { formatWhen } from "./time";

export const Decision = z.object({
  action: z.enum(["none", "create", "update", "add_detail", "cancel", "ask"]),
  event_id: z.number().int().nullable(),
  title: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  all_day: z.boolean().nullable(),
  location: z.string().nullable(),
  detail: z.string().nullable(),
  question: z.string().nullable(),
  question_id: z.number().int().nullable(),
});
export type Decision = z.infer<typeof Decision>;

export interface BrainInput {
  now: string;
  message: { authorName: string; text: string; isEdit: boolean };
  // Event this message replies to or edits, if any.
  linkedEvent: StoredEvent | null;
  quotedText: string | null;
  upcoming: StoredEvent[];
  recent: { authorName: string; text: string }[];
  pending: { id: number; question: string; originalText: string; authorName: string }[];
}

export interface Brain {
  decide(input: BrainInput): Promise<Decision>;
  // A short, playful DM teasing someone for posting off-topic in the events group.
  roast(message: { authorName: string; text: string }): Promise<string>;
}

const SYSTEM = `You keep a family's shared Google Calendar in sync with their Signal "events" group. For each new group message, choose exactly one action and return it as JSON.

Actions:
- create: the message announces a new plan with a specific day. Set title, start, all_day, and location/end when given. If it matches an upcoming event, use update or add_detail instead of creating a duplicate.
- update: the message changes the day, time, title or location of an existing event. Set event_id and only the fields that change; leave the rest null.
- add_detail: a follow-up detail about an existing event (what to bring, who's coming, parking, etc.). Set event_id and a short detail in the writer's own words.
- cancel: plans for an existing event are off. Set event_id.
- ask: the message clearly describes a plan the family would want on the calendar, but the day is ambiguous or missing. Write one short, friendly question in question.
- none: everything else - chatter, reactions, questions about plans, past events, hypotheticals ("we should get together sometime").

Rules:
- Resolve dates relative to "Now". "The 26th" means the next upcoming 26th. A weekday name means the next one.
- start is "YYYY-MM-DDTHH:MM" (24-hour, local time) for timed events, or "YYYY-MM-DD" with all_day true when no time is given. end uses the same format, or null.
- Times without am/pm mean the sensible family-event hour: "at 2" for a lunch or dinner is 14:00.
- Titles are short and natural, e.g. "Thanksgiving at Mom's".
- If the message replies to or edits a message linked to an event, that event is the one being discussed. An edit that removes the plan means cancel; one that changes nothing about the event means none.
- If the message answers a pending question, set question_id to that question's id and act on the original message plus the answer.
- When unsure whether a message is about the calendar at all, choose none.
- Unused fields are null.`;

const ROAST = `Someone posted a message in their family's Signal "events" group, which is only for planning get-togethers. Write the direct message the calendar bot sends them.

- Tease them about this specific message, dryly and sarcastically. Under 30 words in total.
- Work in that the events group is for plans and the family chat is for everything else, in your own words.
- Skip stock openers such as "bold of you" or "I see you've".
- Keep it affectionate: this is family, including grandparents. No insults about looks, age, weight or intelligence, and no swearing.
- Reply with the message text only.`;

function describeEvent(e: StoredEvent): string {
  const parts = [`#${e.id} "${e.title}" ${formatWhen(e.start, e.allDay)} (start ${e.start})`];
  if (e.location) parts.push(`at ${e.location}`);
  if (e.status === "cancelled") parts.push("[cancelled]");
  return parts.join(" ");
}

export function buildPrompt(input: BrainInput): string {
  const lines = [`Now: ${input.now}`, "", "Upcoming events:"];
  lines.push(...(input.upcoming.length ? input.upcoming.map((e) => `- ${describeEvent(e)}`) : ["- (none)"]));

  if (input.pending.length) {
    lines.push("", "Pending questions the bot asked:");
    for (const p of input.pending) {
      lines.push(`- id ${p.id}: asked "${p.question}" about ${p.authorName}'s message: ${JSON.stringify(p.originalText)}`);
    }
  }

  if (input.recent.length) {
    lines.push("", "Recent group messages, oldest first:");
    lines.push(...input.recent.map((m) => `- ${m.authorName}: ${JSON.stringify(m.text)}`));
  }

  lines.push("", "New message:");
  if (input.message.isEdit) lines.push("(This is an edited version of an earlier message.)");
  if (input.linkedEvent) lines.push(`(It ${input.message.isEdit ? "edits" : "replies to"} a message linked to event ${describeEvent(input.linkedEvent)}.)`);
  else if (input.quotedText) lines.push(`(It replies to: ${JSON.stringify(input.quotedText)})`);
  lines.push(`${input.message.authorName}: ${JSON.stringify(input.message.text)}`);
  return lines.join("\n");
}

export class ClaudeBrain implements Brain {
  private client = new Anthropic();

  constructor(private model: string) {}

  async decide(input: BrainInput): Promise<Decision> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: "low", format: zodOutputFormat(Decision) },
      messages: [{ role: "user", content: buildPrompt(input) }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      console.warn(`No decision from Claude (stop_reason=${response.stop_reason})`);
      return { ...NONE };
    }
    return response.parsed_output;
  }

  async roast(message: { authorName: string; text: string }): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1000,
      system: ROAST,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: `${message.authorName} wrote: ${JSON.stringify(message.text)}` }],
    });
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (!text) throw new Error(`Empty roast (stop_reason=${response.stop_reason})`);
    return text;
  }
}

export const NONE: Decision = {
  action: "none",
  event_id: null,
  title: null,
  start: null,
  end: null,
  all_day: null,
  location: null,
  detail: null,
  question: null,
  question_id: null,
};
