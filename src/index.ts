import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Bot } from "./bot";
import { ClaudeBrain } from "./brain";
import { GoogleCalendar } from "./calendar";
import { loadConfig } from "./config";
import { SignalClient, parseEnvelope } from "./signal";
import { Store } from "./store";

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const signal = new SignalClient(config.signalApiUrl, config.signalNumber, config.groupSendId);
const bot = new Bot({
  store: new Store(join(config.dataDir, "bot.sqlite")),
  brain: new ClaudeBrain(config.anthropicModel),
  calendar: new GoogleCalendar({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    refreshToken: config.googleRefreshToken,
    calendarId: config.calendarId,
    timezone: config.timezone,
  }),
  signal,
  members: config.members,
  ownNumber: config.signalNumber,
  timezone: config.timezone,
});

// Handle messages one at a time so replies and edits land in order.
let queue = Promise.resolve();

signal.listen((envelope) => {
  const msg = parseEnvelope(envelope, {
    groupInternalId: config.groupInternalId,
    ownNumber: config.signalNumber,
    nameFor: (n) => bot.nameFor(n),
  });
  if (!msg) return;
  queue = queue.then(() => bot.handle(msg)).catch((err) => console.error("Unhandled error", err));
});

console.log(`Family calendar bot running for ${config.members.length} members`);
