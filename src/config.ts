import { z } from "zod";

const Member = z.object({
  name: z.string(),
  number: z.string(),
  email: z.string().optional(),
  // false = no invite emails; they still see events on the shared calendar
  invites: z.boolean().default(true),
});
export type Member = z.infer<typeof Member>;

export interface Config {
  anthropicModel: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  calendarId: string;
  signalApiUrl: string;
  signalNumber: string;
  // "group.<base64>" form used by the REST API for sending
  groupSendId: string;
  // internal group id as it appears in incoming envelopes
  groupInternalId: string;
  members: Member[];
  timezone: string;
  dataDir: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

// Accepts either the REST API's "group.<base64(internal)>" id or the raw internal id.
export function groupIds(raw: string): { send: string; internal: string } {
  if (raw.startsWith("group.")) {
    return { send: raw, internal: Buffer.from(raw.slice(6), "base64").toString("utf8") };
  }
  return { send: `group.${Buffer.from(raw, "utf8").toString("base64")}`, internal: raw };
}

export function parseMembers(json: string): Member[] {
  return z.array(Member).parse(JSON.parse(json));
}

export function loadConfig(): Config {
  const ids = groupIds(required("SIGNAL_GROUP_ID"));
  return {
    anthropicModel: process.env.CLAUDE_MODEL || "claude-opus-5-5",
    googleClientId: required("GOOGLE_CLIENT_ID"),
    googleClientSecret: required("GOOGLE_CLIENT_SECRET"),
    googleRefreshToken: required("GOOGLE_REFRESH_TOKEN"),
    calendarId: required("GOOGLE_CALENDAR_ID"),
    signalApiUrl: (process.env.SIGNAL_API_URL || "http://localhost:8080").replace(/\/$/, ""),
    signalNumber: required("SIGNAL_NUMBER"),
    groupSendId: ids.send,
    groupInternalId: ids.internal,
    members: parseMembers(required("MEMBERS_JSON")),
    timezone: process.env.TIMEZONE || "America/New_York",
    dataDir: process.env.DATA_DIR || "./data",
  };
}
