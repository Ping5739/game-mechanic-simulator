import { LocalTransport } from "./net/local-transport";
import { DEFAULT_ICE_SERVERS, PeerJsTransport } from "./net/peerjs-transport";
import type { Transport } from "./net/transport";

/**
 * Picks the matchmaking backend. Switching to your own server later is a
 * change here (or a URL parameter while testing), not in the game code.
 *
 *   (default)                    public PeerJS cloud server
 *   ?net=local                   two tabs in the same browser, no server at all
 *   ?peerHost=example.com        your own PeerServer
 *     &peerPort=443&peerPath=/&peerSecure=1
 */
export function transportFromUrl(params = new URLSearchParams(location.search)): Transport {
  if (params.get("net") === "local") return new LocalTransport();
  const host = params.get("peerHost") ?? undefined;
  const port = params.get("peerPort");
  const secure = params.get("peerSecure");
  return new PeerJsTransport({
    host,
    port: port ? Number(port) : undefined,
    path: params.get("peerPath") ?? undefined,
    secure: secure === null ? undefined : secure === "1" || secure === "true",
    iceServers: DEFAULT_ICE_SERVERS,
  });
}
