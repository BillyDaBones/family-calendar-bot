// Gets a Google refresh token for the calendar account.
// Usage: GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... bun run auth:google
// The OAuth client must be a "Desktop app" client.

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.");
  process.exit(1);
}

const port = 53682;
const redirectUri = `http://127.0.0.1:${port}/callback`;
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar",
    access_type: "offline",
    prompt: "consent",
  });

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const code = new URL(req.url).searchParams.get("code");
    if (!code) return new Response("Missing code", { status: 400 });
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const json = (await res.json()) as { refresh_token?: string; error?: string };
    if (!json.refresh_token) {
      console.error("No refresh token returned:", json);
    } else {
      console.log(`\nGOOGLE_REFRESH_TOKEN=${json.refresh_token}\n`);
    }
    setTimeout(() => server.stop(), 100);
    return new Response("Done. You can close this tab and go back to the terminal.");
  },
});

console.log("Opening Google sign-in. Sign in with the account that will own the calendar.");
console.log(authUrl);
Bun.spawn(["open", authUrl]);
