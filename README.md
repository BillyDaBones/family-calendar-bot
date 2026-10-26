# Family Calendar Bot

A Signal bot that turns plans in the family events group into events on a shared "Harris Family" Google Calendar, with invites.

- "Thanksgiving at Mom's on the 26th at 2" creates the event and emails invites.
- "bring folding chairs" is added to that event's description.
- Replying to the bot's message, or editing your original message, updates the event.
- "Thanksgiving is off" cancels it and notifies invitees.
- If the day is unclear, the bot asks one question.
- `!events` lists the next 60 days. `!help` explains the bot.

Every bot message starts with 📅. Messages from other chats are dropped before they are logged or stored.

## How it works

```
Signal group ──ws──▶ signal-cli-rest-api ──▶ bot ──▶ Claude (decides: create / update / detail / cancel / ask / none)
                                              │
                                              └──▶ Google Calendar API (sendUpdates=all)
```

- `src/signal.ts`: receives envelopes over WebSocket, keeps only the events group, and sends replies.
- `src/brain.ts`: makes one Claude call per group message and gets back a structured decision.
- `src/bot.ts`: applies the decision, links Signal messages to events, and handles commands.
- `src/calendar.ts`: the Google Calendar client. Detail updates don't email invitees. Time and place changes and cancellations do.
- `src/store.ts`: SQLite. It holds events, message→event links and open questions. Message text isn't kept, except the original text of a message the bot asked about. That text is deleted after 24 hours.

## Local development

```sh
bun install
bun test
bun check
cp .env.example .env   # fill in, then:
bun start
```

## Setup

### 1. Google Calendar (about 20 minutes)

Do all of this signed in as **the Google account that should own the calendar** (Billy's). Invites go out from that account.

**A. Create the project and turn on the Calendar API (3 min)**

1. Open https://console.cloud.google.com/projectcreate
2. Project name: `family-calendar-bot`. Leave Location as is. Click **Create**.
3. When the notification says it's done, click **Select project**. The project picker at the top left should show `family-calendar-bot`.
4. Open https://console.cloud.google.com/apis/library/calendar-json.googleapis.com and click **Enable**.

**B. Set up the sign-in screen and publish it (5 min)**

1. Open https://console.cloud.google.com/auth/overview and click **Get started**.
2. App information: App name `Family Calendar Bot`, User support email = your email. Click **Next**.
   - Then open the **Branding** page. To publish, Google needs an **App home page**, a **Privacy policy link**, and that domain listed under **Authorized domains**. Use a domain you control, for example `https://sepirak.com` and `https://sepirak.com/privacy`, with a short privacy page live at that link. **Don't upload a logo**: a logo makes Google require brand verification, which can take days. Click **Save**.
3. Audience: choose **External**. Click **Next**. Contact information: your email. Click **Next**. Tick the policy box and click **Continue**, then **Create**.
4. Left sidebar, **Audience**. Under Publishing status, click **Publish app** and then **Confirm**. It should now say **In production**.
   - This is required. In Testing mode, the bot's Google login expires every 7 days.
   - You do **not** need to submit for verification. Unverified apps are limited to 100 users, and only one account (Billy's) ever signs in.

**C. Create the OAuth client (2 min)**

1. Left sidebar, **Clients**, then **Create client**.
2. Application type: **Desktop app**. Name: `family-calendar-bot`. Click **Create**.
3. Copy the **Client ID** and **Client secret** right away. Google only shows the secret once. If you lose it, delete the client and make a new one.
4. In this folder, run `cp .env.example .env` and paste them in:
   ```
   GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

**D. Get the refresh token (3 min)**

1. Run `bun run auth:google`. A browser tab opens.
2. Pick Billy's Google account.
3. You'll see **"Google hasn't verified this app"**. This is expected because it's your own app. Click **Advanced**, then **Go to Family Calendar Bot (unsafe)**.
4. On the permissions screen, **tick the box** for "See, edit, share, and permanently delete all the calendars…" and click **Continue**. If you skip the box, the bot can't write to the calendar.
5. The tab says "Done". In the terminal, copy the `GOOGLE_REFRESH_TOKEN=...` line into `.env`.

**E. Create and share the calendar (5 min)**

1. In `.env`, set `TIMEZONE` (for example `America/Chicago`) and fill in `MEMBERS_JSON` with everyone's name, number and email (format below).
2. Run `bun run setup:calendar`. It creates **Harris Family** and shares it with every email in `MEMBERS_JSON` as an editor.
3. Copy the printed `GOOGLE_CALENDAR_ID=...@group.calendar.google.com` line into `.env`.
4. Each family member gets an email titled "…has shared a calendar with you". They click **Add this calendar**.
5. Check it: open https://calendar.google.com as Billy. **Harris Family** should be listed under "My calendars".

Added someone later? Update `MEMBERS_JSON` and run `bun run setup:calendar` again with `GOOGLE_CALENDAR_ID` set. It re-shares the existing calendar instead of creating a new one.

**If something goes wrong**

| You see | Fix |
|---|---|
| "Access blocked: … has not completed the Google verification process" | The app is still in Testing. Redo B4. |
| Terminal says `No refresh token returned` | Remove the app at https://myaccount.google.com/connections, then rerun `bun run auth:google` |
| Bot logs `invalid_grant` days later | The app was left in Testing, or the token was revoked. Redo B4 and step D, then update the Railway variable. |
| `setup:calendar` returns 403 `insufficientPermissions` | The permission box in D4 wasn't ticked. Redo step D. |
| `Calendar API has not been used in project` | Redo A4 and make sure `family-calendar-bot` is the selected project. |

### 2. Railway

Create one project with two services. Neither gets a public domain, apart from step 2 below.

**signal**
- Image: `bbernhardt/signal-cli-rest-api`, pinned to a specific version tag instead of `latest`
- Variable: `MODE=json-rpc`
- Volume mounted at `/home/.local/share/signal-cli`

**bot**
- Source: this repo (private GitHub), deployed from `main`. Railway picks up the Dockerfile.
- Volume mounted at `/app/data`
- Variables: everything in `.env.example`, with `SIGNAL_API_URL=http://signal.railway.internal:8080`

Steps:
1. Push this repo to a private GitHub repo and connect it to Railway.
2. Add the signal service and its volume. Give it a temporary public domain, open `https://<domain>/v1/qrcodelink?device_name=family-calendar-bot`, and scan the QR code on Billy's phone (Signal → Settings → Linked devices). Then remove the domain.
3. Create the events group in Signal. To get its ID, run `bun run signal:groups` against the signal service while the temporary domain is still up, or from a Railway shell.
4. Set the bot's variables and deploy.
5. Test in the group with Billy and Johnny. Then add everyone and post `!help`.

### MEMBERS_JSON

```json
[
  { "name": "Billy", "number": "+15555550100", "email": "billy@gmail.com", "invites": true },
  { "name": "Grandma", "number": "+15555550101", "email": "grandma@gmail.com", "invites": false }
]
```

`invites: false` means no invite emails. That person still sees events on the shared calendar if they accepted the share.

## Notes

- The model defaults to `claude-opus-5-5` at low effort. Set `CLAUDE_MODEL` to change it.
- `TIMEZONE` defaults to `America/New_York`. Event times are stored as local wall-clock times in that zone.
- Timed events without an end get two hours. Events without a time are all-day.
