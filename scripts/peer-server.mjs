// Local PeerServer for development and tests:  npm run peer-server
// Then open the site with ?peerHost=localhost&peerPort=9000&peerPath=/&peerSecure=0
import { PeerServer } from "peer";

const port = Number(process.env.PORT ?? 9000);
const host = process.env.HOST ?? "127.0.0.1";

PeerServer({ port, host, path: "/" }, () => console.log(`PeerServer listening on http://${host}:${port}/`));
