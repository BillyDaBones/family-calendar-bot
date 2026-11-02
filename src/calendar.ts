import { addDays, addHours } from "./time";

export interface CalendarEvent {
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  location: string | null;
  description: string;
}

export interface ListedEvent extends CalendarEvent {
  gcalId: string;
}

export interface CalendarApi {
  create(event: CalendarEvent, attendees: string[]): Promise<string>;
  // notify=false saves the change without emailing invitees.
  update(gcalId: string, event: CalendarEvent, notify: boolean): Promise<void>;
  cancel(gcalId: string): Promise<void>;
  // Every event on the calendar starting on a local date in [fromDate, toDate), including ones added outside the bot.
  list(fromDate: string, toDate: string): Promise<ListedEvent[]>;
}

const API = "https://www.googleapis.com/calendar/v3";

export class GoogleCalendar implements CalendarApi {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private opts: {
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      calendarId: string;
      timezone: string;
    },
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
        refresh_token: this.opts.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return this.token.value;
  }

  private async request(method: string, path: string, body?: unknown, notify = true, query: Record<string, string> = {}): Promise<any> {
    // sendUpdates=all emails invitees about creates, changes and cancellations.
    const params = new URLSearchParams({ sendUpdates: notify ? "all" : "none", ...query });
    const url = `${API}/calendars/${encodeURIComponent(this.opts.calendarId)}${path}?${params}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Google Calendar ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  }

  private toResource(event: CalendarEvent) {
    const tz = this.opts.timezone;
    const when = event.allDay
      ? {
          start: { date: event.start },
          // Google's all-day end date is exclusive.
          end: { date: addDays(event.end ?? event.start, 1) },
        }
      : {
          start: { dateTime: `${event.start}:00`, timeZone: tz },
          end: { dateTime: `${event.end ?? addHours(event.start, 2)}:00`, timeZone: tz },
        };
    return {
      summary: event.title,
      location: event.location ?? "",
      description: event.description,
      ...when,
    };
  }

  async create(event: CalendarEvent, attendees: string[]): Promise<string> {
    const resource = { ...this.toResource(event), attendees: attendees.map((email) => ({ email })) };
    const json = await this.request("POST", "/events", resource);
    return json.id as string;
  }

  // Attendees are left alone on update so their RSVP status isn't reset.
  async update(gcalId: string, event: CalendarEvent, notify: boolean): Promise<void> {
    await this.request("PATCH", `/events/${encodeURIComponent(gcalId)}`, this.toResource(event), notify);
  }

  async cancel(gcalId: string): Promise<void> {
    await this.request("DELETE", `/events/${encodeURIComponent(gcalId)}`);
  }

  async list(fromDate: string, toDate: string): Promise<ListedEvent[]> {
    // Query a day wider on each side so timezone offsets can't drop events, then filter on local dates.
    const query = {
      timeMin: `${addDays(fromDate, -1)}T00:00:00Z`,
      timeMax: `${addDays(toDate, 1)}T00:00:00Z`,
      timeZone: this.opts.timezone,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    };
    const items: any[] = [];
    let pageToken: string | undefined;
    do {
      const json = await this.request("GET", "/events", undefined, false, pageToken ? { ...query, pageToken } : query);
      items.push(...json.items);
      pageToken = json.nextPageToken;
    } while (pageToken);

    return items
      .filter((item) => item.status !== "cancelled")
      .map((item) => {
        const allDay = !item.start.dateTime;
        return {
          // Recurring instances carry their series id, which is what the bot stores.
          gcalId: (item.recurringEventId ?? item.id) as string,
          title: item.summary ?? "(no title)",
          // dateTime comes back in the requested timeZone, so its first 16 characters are local wall-clock time.
          start: allDay ? item.start.date : item.start.dateTime.slice(0, 16),
          end: allDay ? addDays(item.end.date, -1) : item.end.dateTime.slice(0, 16),
          allDay,
          location: item.location ?? null,
          description: item.description ?? "",
        };
      })
      .filter((e) => e.start.slice(0, 10) >= fromDate && e.start.slice(0, 10) < toDate);
  }
}
