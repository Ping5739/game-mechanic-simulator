import { decode, encode, makeRoomCode, normalizeRoomCode, type Connection, type HostRoom, type Transport } from "./transport";

/**
 * Same-browser transport over BroadcastChannel. Lets you test multiplayer in
 * two tabs with no internet or matchmaking server at all (add ?net=local).
 */

type Envelope =
  | { k: "connect"; from: string }
  | { k: "accept"; to: string }
  | { k: "data"; from: string; to: string; d: string }
  | { k: "close"; from: string; to: string };

const channelName = (code: string) => `gms-local-${code}`;

class LocalConnection implements Connection {
  private msgCbs: ((m: unknown) => void)[] = [];
  private closeCbs: (() => void)[] = [];
  private closed = false;

  constructor(
    readonly id: string,
    private readonly self: string,
    private readonly ch: BroadcastChannel,
  ) {}

  deliver(d: string): void {
    const m = decode(d);
    if (m !== undefined) for (const cb of this.msgCbs) cb(m);
  }

  remoteClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
  }

  send(msg: unknown): void {
    if (this.closed) return;
    this.ch.postMessage({ k: "data", from: this.self, to: this.id, d: encode(msg) } satisfies Envelope);
  }

  onMessage(cb: (msg: unknown) => void): void {
    this.msgCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  close(): void {
    if (this.closed) return;
    this.ch.postMessage({ k: "close", from: this.self, to: this.id } satisfies Envelope);
    this.remoteClosed();
  }
}

export class LocalTransport implements Transport {
  readonly name = "Local (same browser)";

  async createRoom(): Promise<HostRoom> {
    const code = makeRoomCode();
    const hostId = `host-${code}`;
    const ch = new BroadcastChannel(channelName(code));
    const conns = new Map<string, LocalConnection>();
    let onConn: (c: Connection) => void = () => {};
    ch.onmessage = (e: MessageEvent<Envelope>) => {
      const m = e.data;
      if (m.k === "connect") {
        const conn = new LocalConnection(m.from, hostId, ch);
        conns.set(m.from, conn);
        ch.postMessage({ k: "accept", to: m.from } satisfies Envelope);
        onConn(conn);
      } else if (m.k === "data" && m.to === hostId) {
        conns.get(m.from)?.deliver(m.d);
      } else if (m.k === "close" && m.to === hostId) {
        conns.get(m.from)?.remoteClosed();
        conns.delete(m.from);
      }
    };
    // Tell clients when this tab goes away.
    const bye = () => conns.forEach((c) => c.close());
    addEventListener("pagehide", bye);
    return {
      code,
      onConnection: (cb) => (onConn = cb),
      onError: () => {},
      close: () => {
        bye();
        removeEventListener("pagehide", bye);
        ch.close();
      },
    };
  }

  joinRoom(rawCode: string): Promise<Connection> {
    const code = normalizeRoomCode(rawCode);
    const me = `client-${crypto.randomUUID().slice(0, 8)}`;
    const hostId = `host-${code}`;
    const ch = new BroadcastChannel(channelName(code));
    return new Promise((resolve, reject) => {
      let conn: LocalConnection | undefined;
      const timer = setTimeout(() => {
        ch.close();
        reject(new Error(`No room with code ${code} in this browser.`));
      }, 3000);
      ch.onmessage = (e: MessageEvent<Envelope>) => {
        const m = e.data;
        if (m.k === "accept" && m.to === me && !conn) {
          clearTimeout(timer);
          conn = new LocalConnection(hostId, me, ch);
          addEventListener("pagehide", () => conn?.close());
          resolve(conn);
        } else if (conn && m.k === "data" && m.to === me) {
          conn.deliver(m.d);
        } else if (conn && m.k === "close" && m.to === me) {
          conn.remoteClosed();
        }
      };
      ch.postMessage({ k: "connect", from: me } satisfies Envelope);
    });
  }
}
