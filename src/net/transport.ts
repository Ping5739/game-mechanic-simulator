/**
 * Transport abstraction. The game only talks to these interfaces, so the
 * matchmaking backend (public PeerJS server today, your own PeerServer or a
 * Cloudflare Worker later) can be swapped without touching game code.
 */

export interface Connection {
  /** Remote peer's id. */
  readonly id: string;
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface HostRoom {
  readonly code: string;
  onConnection(cb: (conn: Connection) => void): void;
  /** Called if the room's link to the matchmaking server drops and can't recover. */
  onError(cb: (err: string) => void): void;
  close(): void;
}

export interface Transport {
  readonly name: string;
  createRoom(): Promise<HostRoom>;
  joinRoom(code: string): Promise<Connection>;
}

/** Byte counters, shared by all connections, for the debug overlay. */
export const netStats = {
  bytesOut: 0,
  bytesIn: 0,
  msgsOut: 0,
  msgsIn: 0,
};

/** Unambiguous characters only (no 0/O, 1/I/L). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function makeRoomCode(length = 5): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export function normalizeRoomCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function encode(msg: unknown): string {
  const s = JSON.stringify(msg);
  netStats.bytesOut += s.length;
  netStats.msgsOut++;
  return s;
}

export function decode(data: unknown): unknown {
  if (typeof data !== "string") return data;
  netStats.bytesIn += data.length;
  netStats.msgsIn++;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
