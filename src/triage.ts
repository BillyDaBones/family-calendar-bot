import { z } from "zod";
import type { StoredEvent } from "./store";
import { formatWhen } from "./time";

// Runs only on messages Claude chose "none" for. Jev answers yes/no questions about the
// message; triageAction() turns those answers into what the bot does.

export interface TriageInput {
  message: { authorName: string; text: string };
  recent: { authorName: string; text: string }[];
  upcoming: StoredEvent[];
  pendingQuestions: string[];
}

type Noul = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

function noul(instructions: string, criteria?: { true: string; false: string }): Noul {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

// Probability that each answer is yes. answersBot is null when the bot has no open question.
export interface Judgments {
  announcesPlan: number;
  changesPlan: number;
  addsDetail: number;
  cancelsPlan: number;
  answersBot: number | null;
  asksAboutEvents: number;
  asksHowToUseBot: number;
}

export interface Triage {
  judge(input: TriageInput): Promise<Judgments>;
}

export type TriageAction = "keep" | "delete" | "dm_help" | "dm_events";

const YES = 0.7;
const NO = 0.3;

export function triageAction(j: Judgments): TriageAction {
  const related = [j.announcesPlan, j.changesPlan, j.addsDetail, j.cancelsPlan, j.answersBot ?? 0];
  // Anything that might be about creating or changing an event stays, including unsure answers.
  if (related.some((p) => p >= NO)) return "keep";
  if (j.asksHowToUseBot >= YES) return "dm_help";
  if (j.asksAboutEvents >= YES) return "dm_events";
  if (j.asksHowToUseBot >= NO || j.asksAboutEvents >= NO) return "keep";
  return "delete";
}

export function buildState(input: TriageInput) {
  const state: Record<string, unknown> = {
    message: { from: input.message.authorName, text: input.message.text },
  };
  if (input.recent.length) state.recent_messages = input.recent.map((m) => ({ from: m.authorName, text: m.text }));
  if (input.upcoming.length) state.upcoming_events = input.upcoming.map((e) => `${e.title}, ${formatWhen(e.start, e.allDay)}`);
  if (input.pendingQuestions.length) state.bot_questions = input.pendingQuestions;
  return state;
}

export function buildQuestions(input: TriageInput): Record<string, Noul> {
  const questions = {
    announcesPlan: noul("Does `message` announce a new plan for the family to get together on a particular day?", {
      true: "Names a gathering, meal, trip or party that someone intends to hold, such as dinner at Mom's on Sunday",
      false: "Chatter, news, jokes, photos, or a vague wish like we should get together sometime",
    }),
    changesPlan: noul("Does `message` change the day, time, place or name of a planned family event?"),
    addsDetail: noul("Does `message` add a practical detail to a planned family event, such as what to bring or who is coming?"),
    cancelsPlan: noul("Does `message` say that a planned family event is off?"),
    asksAboutEvents: noul("Does `message` ask when, where or what a planned family event is?", {
      true: "A question such as what time is Thanksgiving, or what's coming up this month",
      false: "A statement, or a question about something other than family events",
    }),
    asksHowToUseBot: noul("Does `message` ask how to use the family calendar or the calendar bot?", {
      true: "A question such as how do I add an event, or how do I get the calendar on my phone",
      false: "A question or comment that isn't about using the calendar",
    }),
  };
  if (!input.pendingQuestions.length) return questions;
  return { ...questions, answersBot: noul("Does `message` answer one of `bot_questions`?") };
}

const Response = z.object({
  answers: z.record(z.string(), z.object({ type: z.literal("noul"), noul: z.number() })),
});

// Calls the HTTP API directly: @typesafe-ai/sdk 0.7 reads each response body twice, which Bun rejects.
export class JevTriage implements Triage {
  constructor(
    private apiKey: string,
    private model: string,
  ) {}

  async judge(input: TriageInput): Promise<Judgments> {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, state: buildState(input), questions: buildQuestions(input) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`TypeSafe request failed: ${res.status} ${await res.text()}`);
    const { answers } = Response.parse(await res.json());
    const p = (id: string) => {
      const answer = answers[id];
      if (!answer) throw new Error(`TypeSafe response is missing ${id}`);
      return answer.noul;
    };
    return {
      announcesPlan: p("announcesPlan"),
      changesPlan: p("changesPlan"),
      addsDetail: p("addsDetail"),
      cancelsPlan: p("cancelsPlan"),
      answersBot: input.pendingQuestions.length ? p("answersBot") : null,
      asksAboutEvents: p("asksAboutEvents"),
      asksHowToUseBot: p("asksHowToUseBot"),
    };
  }
}
