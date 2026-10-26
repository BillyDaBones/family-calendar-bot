import { describe, expect, test } from "bun:test";
import { groupIds } from "../src/config";
import { parseEnvelope } from "../src/signal";

const GROUP = "abc123internal==";
const opts = { groupInternalId: GROUP, ownNumber: "+1000", nameFor: (n: string) => (n === "+1222" ? "Johnny" : undefined) };

describe("parseEnvelope", () => {
  test("accepts a text message in the events group", () => {
    const msg = parseEnvelope(
      { sourceNumber: "+1222", dataMessage: { timestamp: 5, message: " hi ", groupInfo: { groupId: GROUP } } },
      opts,
    );
    expect(msg).toEqual({ kind: "message", ts: 5, author: "+1222", authorName: "Johnny", text: "hi" });
  });

  test("drops messages from other groups and direct chats", () => {
    expect(
      parseEnvelope({ sourceNumber: "+1222", dataMessage: { timestamp: 5, message: "hi", groupInfo: { groupId: "other" } } }, opts),
    ).toBeNull();
    expect(parseEnvelope({ sourceNumber: "+1222", dataMessage: { timestamp: 5, message: "hi" } }, opts)).toBeNull();
    expect(
      parseEnvelope({ syncMessage: { sentMessage: { timestamp: 5, message: "hi", groupInfo: { groupId: "other" } } } }, opts),
    ).toBeNull();
  });

  test("uses the original timestamp for edits", () => {
    const msg = parseEnvelope(
      {
        sourceNumber: "+1222",
        editMessage: { targetSentTimestamp: 5, dataMessage: { timestamp: 9, message: "new", groupInfo: { groupId: GROUP } } },
      },
      opts,
    );
    expect(msg?.kind).toBe("edit");
    expect(msg?.ts).toBe(5);
  });

  test("attributes messages sent from the owner's phone to the owner", () => {
    const msg = parseEnvelope(
      { syncMessage: { sentMessage: { timestamp: 7, message: "dinner sat", groupInfo: { groupId: GROUP } } } },
      opts,
    );
    expect(msg?.author).toBe("+1000");
  });

  test("captures quotes", () => {
    const msg = parseEnvelope(
      {
        sourceNumber: "+1222",
        dataMessage: { timestamp: 8, message: "make it 3", groupInfo: { groupId: GROUP }, quote: { id: 6, authorNumber: "+1000", text: "📅 Added" } },
      },
      opts,
    );
    expect(msg?.quote).toEqual({ ts: 6, author: "+1000", text: "📅 Added" });
  });
});

describe("groupIds", () => {
  test("converts between send id and internal id", () => {
    const { send, internal } = groupIds(GROUP);
    expect(groupIds(send)).toEqual({ send, internal });
    expect(internal).toBe(GROUP);
  });
});
