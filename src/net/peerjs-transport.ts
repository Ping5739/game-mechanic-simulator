import { Peer, type DataConnection, type PeerOptions } from "peerjs";
import { decode, encode, makeRoomCode, normalizeRoomCode, type Connection, type HostRoom, type Transport } from "./transport";

/** Prefix keeps our room ids from colliding with other apps on a shared PeerJS server. */
const ID_PREFIX = "gms1-";

export interface PeerJsConfig {
  /** Leave undefined to use the public PeerJS cloud server (0.peerjs.com). */
  host?: string;
  port?: number;
  path?: string;
  secure?: boolean;
  iceServers: RTCIceServer[];
}

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  // A TURN relay goes here before a public launch, e.g.
  // { urls: "turn:turn.example.com:3478", username: "...", credential: "..." },
];

class PeerJsConnection implements Connection {
  constructor(private readonly dc: DataConnection) {}

  get id(): string {
    return this.dc.peer;
  }

  send(msg: unknown): void {
    if (this.dc.open) void this.dc.send(encode(msg));
  }

  onMessage(cb: (msg: unknown) => void): void {
    this.dc.on("data", (d) => {
      const m = decode(d);
      if (m !== undefined) cb(m);
    });
  }

  onClose(cb: () => void): void {
    this.dc.on("close", cb);
    this.dc.on("error", cb);
    // Detect peers that vanish without a clean close (tab killed, Wi-Fi lost).
    this.dc.peerConnection?.addEventListener("connectionstatechange", () => {
      const s = this.dc.peerConnection?.connectionState;
      if (s === "failed" || s === "closed") cb();
    });
  }

  close(): void {
    this.dc.close();
  }
}

export class PeerJsTransport implements Transport {
  readonly name: string;

  constructor(private readonly cfg: PeerJsConfig) {
    this.name = cfg.host ? `PeerJS (${cfg.host})` : "PeerJS (public server)";
  }

  private peerOptions(): PeerOptions {
    const o: PeerOptions = { config: { iceServers: this.cfg.iceServers }, debug: 1 };
    if (this.cfg.host) {
      o.host = this.cfg.host;
      if (this.cfg.port !== undefined) o.port = this.cfg.port;
      if (this.cfg.path !== undefined) o.path = this.cfg.path;
      if (this.cfg.secure !== undefined) o.secure = this.cfg.secure;
    }
    return o;
  }

  private openPeer(id?: string): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, this.peerOptions()) : new Peer(this.peerOptions());
      const timer = setTimeout(() => {
        peer.destroy();
        reject(new Error("Timed out reaching the matchmaking server."));
      }, 15000);
      peer.once("open", () => {
        clearTimeout(timer);
        resolve(peer);
      });
      peer.once("error", (err) => {
        clearTimeout(timer);
        peer.destroy();
        reject(err);
      });
    });
  }

  async createRoom(): Promise<HostRoom> {
    // Retry a few times in the unlikely event a room code is already taken.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeRoomCode();
      let peer: Peer;
      try {
        peer = await this.openPeer(ID_PREFIX + code.toLowerCase());
      } catch (err) {
        if ((err as { type?: string }).type === "unavailable-id") continue;
        throw new Error(describeError(err));
      }
      return new PeerJsHostRoom(code, peer);
    }
    throw new Error("Couldn't find a free room code; please try again.");
  }

  async joinRoom(rawCode: string): Promise<Connection> {
    const code = normalizeRoomCode(rawCode);
    let peer: Peer;
    try {
      peer = await this.openPeer();
    } catch (err) {
      throw new Error(describeError(err));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        peer.destroy();
        reject(new Error("Couldn't connect to the host. They may be behind a strict firewall (a TURN relay would fix this)."));
      }, 20000);
      peer.once("error", (err) => {
        clearTimeout(timer);
        peer.destroy();
        reject(new Error((err as { type?: string }).type === "peer-unavailable" ? `No room with code ${code}.` : describeError(err)));
      });
      const dc = peer.connect(ID_PREFIX + code.toLowerCase(), { serialization: "raw", reliable: true });
      dc.once("open", () => {
        clearTimeout(timer);
        // Once connected we no longer need the matchmaking server.
        peer.disconnect();
        const conn = new PeerJsConnection(dc);
        conn.onClose(() => peer.destroy());
        resolve(conn);
      });
    });
  }
}

class PeerJsHostRoom implements HostRoom {
  private errorCb: (err: string) => void = () => {};

  constructor(
    readonly code: string,
    private readonly peer: Peer,
  ) {
    // If the link to the matchmaking server drops, existing players stay
    // connected; we just try to re-register so new players can still join.
    peer.on("disconnected", () => {
      setTimeout(() => {
        if (!peer.destroyed) peer.reconnect();
      }, 2000);
    });
    peer.on("error", (err) => {
      const type = (err as { type?: string }).type;
      if (type === "peer-unavailable" || type === "network" || type === "server-error") return;
      this.errorCb(describeError(err));
    });
  }

  onConnection(cb: (conn: Connection) => void): void {
    this.peer.on("connection", (dc) => {
      dc.once("open", () => cb(new PeerJsConnection(dc)));
    });
  }

  onError(cb: (err: string) => void): void {
    this.errorCb = cb;
  }

  close(): void {
    this.peer.destroy();
  }
}

function describeError(err: unknown): string {
  const type = (err as { type?: string })?.type;
  switch (type) {
    case "network":
    case "server-error":
    case "socket-error":
    case "socket-closed":
      return "Couldn't reach the matchmaking server. It may be down; try again shortly.";
    case "browser-incompatible":
      return "This browser doesn't support WebRTC.";
    default:
      return (err as Error)?.message ?? String(err);
  }
}
