// Lists the Signal groups on the linked account so you can copy the events group's id.
// Usage: SIGNAL_API_URL=... SIGNAL_NUMBER=... bun run signal:groups

const api = (process.env.SIGNAL_API_URL || "http://localhost:8080").replace(/\/$/, "");
const number = process.env.SIGNAL_NUMBER;
if (!number) throw new Error("Set SIGNAL_NUMBER");

const res = await fetch(`${api}/v1/groups/${encodeURIComponent(number)}`);
if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
const groups = (await res.json()) as { name: string; id: string }[];
for (const g of groups) console.log(`${g.name}\n  SIGNAL_GROUP_ID=${g.id}`);
