import { describe, expect, test } from "bun:test";
import { buildQuestions, triageAction, type Judgments } from "../src/triage";

const clearNo: Judgments = {
  announcesPlan: 0.02,
  changesPlan: 0.02,
  addsDetail: 0.02,
  cancelsPlan: 0.02,
  answersBot: null,
  asksAboutEvents: 0.05,
  asksHowToUseBot: 0.05,
};

describe("triageAction", () => {
  test("deletes chatter that is clearly unrelated", () => {
    expect(triageAction(clearNo)).toBe("delete");
  });

  test("keeps anything that might create or change an event", () => {
    for (const key of ["announcesPlan", "changesPlan", "addsDetail", "cancelsPlan", "answersBot"] as const) {
      expect(triageAction({ ...clearNo, [key]: 0.5 })).toBe("keep");
    }
  });

  test("DMs help for how-to questions, ahead of the events list", () => {
    expect(triageAction({ ...clearNo, asksHowToUseBot: 0.9 })).toBe("dm_help");
    expect(triageAction({ ...clearNo, asksHowToUseBot: 0.9, asksAboutEvents: 0.9 })).toBe("dm_help");
  });

  test("DMs the events list for questions about events", () => {
    expect(triageAction({ ...clearNo, asksAboutEvents: 0.9 })).toBe("dm_events");
  });

  test("keeps a message when the question answers are unsettled", () => {
    expect(triageAction({ ...clearNo, asksAboutEvents: 0.5 })).toBe("keep");
  });
});

test("asks whether the message answers the bot only when a question is open", () => {
  const base = { message: { authorName: "Johnny", text: "hi" }, recent: [], upcoming: [] };
  expect("answersBot" in buildQuestions({ ...base, pendingQuestions: [] })).toBe(false);
  expect("answersBot" in buildQuestions({ ...base, pendingQuestions: ["Which Friday?"] })).toBe(true);
});
