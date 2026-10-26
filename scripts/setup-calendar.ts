// Creates the "Harris Family" calendar (unless GOOGLE_CALENDAR_ID is set) and shares it
// with every member's email so they can see and fix events.
// Usage: bun run setup:calendar   (reads .env)

import { parseMembers } from "../src/config";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  body: new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    client_secret: env("GOOGLE_CLIENT_SECRET"),
    refresh_token: env("GOOGLE_REFRESH_TOKEN"),
    grant_type: "refresh_token",
  }),
});
const { access_token } = (await tokenRes.json()) as { access_token: string };

async function google(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}

let calendarId = process.env.GOOGLE_CALENDAR_ID;
if (!calendarId) {
  const created = await google("POST", "/calendars", {
    summary: "Harris Family",
    timeZone: process.env.TIMEZONE || "America/New_York",
  });
  calendarId = created.id as string;
  console.log(`Created calendar.\nGOOGLE_CALENDAR_ID=${calendarId}`);
}

for (const member of parseMembers(env("MEMBERS_JSON"))) {
  if (!member.email) continue;
  await google("POST", `/calendars/${encodeURIComponent(calendarId)}/acl?sendNotifications=true`, {
    role: "writer",
    scope: { type: "user", value: member.email },
  });
  console.log(`Shared with ${member.name} <${member.email}>`);
}
