// Client for bbernhardt/signal-cli-rest-api running in MODE=json-rpc.

export interface Incoming {
  kind: "message" | "edit";
  // Timestamp that identifies the message. For edits, this is the ORIGINAL message's timestamp.
  ts: number;
  author: string;
  authorName: string;
  text: string;
  quote?: { ts: number; author: string; text?: string };
}

export interface QuoteRef {
  ts: number;
  author: string;
  text: string;
}

export interface Sender {
  // Posts to the events group and returns the sent message's timestamp.
  send(text: string, quote?: QuoteRef): Promise<number>;
  // Sends a direct message to one member.
  sendDirect(number: string, text: string): Promise<void>;
  // Deletes one of this account's own group messages for everyone.
  remoteDelete(ts: number): Promise<void>;
}

type DataMessage = {
  timestamp?: number;
  message?: string | null;
  groupInfo?: { groupId?: string };
  quote?: { id?: number; author?: string; authorNumber?: string; text?: string };
};

type Envelope = {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  dataMessage?: DataMessage;
  editMessage?: { targetSentTimestamp?: number; dataMessage?: DataMessage };
  syncMessage?: {
    sentMessage?: DataMessage & { editMessage?: { targetSentTimestamp?: number; dataMessage?: DataMessage } };
  };
};

// Turns a raw envelope into a group message, or null if it isn't a text message in
// the events group. Anything from another chat is dropped here, before it is logged or stored.
export function parseEnvelope(
  envelope: Envelope,
  opts: { groupInternalId: string; ownNumber: string; nameFor: (number: string) => string | undefined },
): Incoming | null {
  let author = envelope.sourceNumber || envelope.source || "";
  let kind: Incoming["kind"] = "message";
  let data: DataMessage | undefined;
  let editTarget: number | undefined;

  if (envelope.editMessage) {
    kind = "edit";
    data = envelope.editMessage.dataMessage;
    editTarget = envelope.editMessage.targetSentTimestamp;
  } else if (envelope.dataMessage) {
    data = envelope.dataMessage;
  } else if (envelope.syncMessage?.sentMessage) {
    // Sent from the account owner's own phone.
    const sent = envelope.syncMessage.sentMessage;
    author = opts.ownNumber;
    if (sent.editMessage) {
      kind = "edit";
      data = sent.editMessage.dataMessage;
      editTarget = sent.editMessage.targetSentTimestamp;
    } else {
      data = sent;
    }
  }

  if (!data || data.groupInfo?.groupId !== opts.groupInternalId) return null;
  const text = data.message?.trim();
  const ts = kind === "edit" ? editTarget : data.timestamp;
  if (!text || !ts || !author) return null;

  const msg: Incoming = {
    kind,
    ts,
    author,
    authorName: opts.nameFor(author) || envelope.sourceName || author,
    text,
  };
  const quoteAuthor = data.quote?.authorNumber || data.quote?.author;
  if (data.quote?.id && quoteAuthor) {
    msg.quote = { ts: data.quote.id, author: quoteAuthor, text: data.quote.text };
  }
  return msg;
}

// /v2/send answers with { timestamp } or, on some versions, [{ timestamp }].
export function sentTimestamp(json: unknown): number {
  const item = (Array.isArray(json) ? json[0] : json) as { timestamp?: string | number } | undefined;
  const ts = Number(item?.timestamp);
  if (!Number.isSafeInteger(ts) || ts <= 0) throw new Error(`Signal send returned no timestamp: ${JSON.stringify(json)}`);
  return ts;
}

export class SignalClient implements Sender {
  constructor(
    private apiUrl: string,
    private number: string,
    private groupSendId: string,
  ) {}

  async send(text: string, quote?: QuoteRef): Promise<number> {
    const body: Record<string, unknown> = {
      number: this.number,
      recipients: [this.groupSendId],
      message: text,
    };
    if (quote) {
      body.quote_timestamp = quote.ts;
      body.quote_author = quote.author;
      body.quote_message = quote.text;
    }
    const res = await fetch(`${this.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Signal send failed: ${res.status} ${await res.text()}`);
    return sentTimestamp(await res.json());
  }

  async sendDirect(number: string, text: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number: this.number, recipients: [number], message: text }),
    });
    if (!res.ok) throw new Error(`Signal direct send failed: ${res.status} ${await res.text()}`);
  }

  async remoteDelete(ts: number): Promise<void> {
    const res = await fetch(`${this.apiUrl}/v1/remote-delete/${encodeURIComponent(this.number)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: this.groupSendId, timestamp: ts }),
    });
    if (!res.ok) throw new Error(`Signal remote delete failed: ${res.status} ${await res.text()}`);
  }

  // Streams envelopes forever, reconnecting with backoff when the socket drops.
  listen(onEnvelope: (envelope: Envelope) => void): void {
    const url = `${this.apiUrl.replace(/^http/, "ws")}/v1/receive/${encodeURIComponent(this.number)}`;
    let delay = 1000;
    const connect = () => {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        delay = 1000;
        console.log("Connected to Signal");
      };
      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as { envelope?: Envelope };
          if (parsed.envelope) onEnvelope(parsed.envelope);
        } catch (err) {
          console.error("Bad Signal payload", err);
        }
      };
      ws.onclose = () => {
        console.warn(`Signal socket closed; reconnecting in ${delay / 1000}s`);
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 60_000);
      };
      ws.onerror = () => ws.close();
    };
    connect();
  }
}
