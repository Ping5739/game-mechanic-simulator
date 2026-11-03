# Encounter practice simulator

A browser-based practice tool for boss-fight mechanics. Practice alone with
bots, or create a room and share the code with friends. There's no game
server: the host's browser runs the fight and everyone connects to it
peer-to-peer.

This is the proof of concept. It ships one test encounter ("Training Dummy")
covering the basic mechanic types: out, in, spread, stack, line, cone and
random puddles.

## Playing

- **Practice solo** – you plus 7 bots, no network needed.
- **Create a room** – you get a 5-letter code. Click it to copy an invite link.
- **Join room** – enter a friend's code (or open their invite link).

### Controls

| Key / mouse | Does |
|---|---|
| <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows | Move. In 3D, relative to the camera; in 2D, W is north |
| Hold right mouse + drag (3D) | Turn the camera; scroll to zoom |
| <kbd>Space</kbd> | Pause / resume (host only) |
| <kbd>G</kbd> | Show / hide your ghost |
| <kbd>V</kbd> | Switch between 3D and 2D top-down |
| <kbd>`</kbd> | Network and performance stats |

### Views

The 3D view is the default; the 2D top-down view is one click (or <kbd>V</kbd>)
away. Characters are upside-down tetrahedra standing on their tip: the tip
is the hitbox, and the white edge running up to the front corner shows which
way they face. The boss is a larger, half-transparent tetrahedron that turns
toward its directional attacks; its hitbox is the dashed ring on the floor.
The 2D view draws the same shapes seen from above.

### Pause

The host can pause at any time (Space or the Pause button). Everything
freezes for everyone, including movement, but you can still look around,
toggle the ghost and see its route, and the host can jump the timeline while
paused.

The bar across the top shows every mechanic in the loop with a playhead
for "now". The host can click anywhere on it to jump to that moment, or click
a mechanic's name to jump to 2 seconds before it. Everyone is placed where the
strategy says they should be at that moment, and casts already underway
restart part-way through. Arrow keys on the focused bar jump ±5 s.

**Show my ghost** (or press <kbd>G</kbd>) draws a hollow copy of you: a
perfect player in your slot following the strategy, with a dashed line to
where it's heading next. A player who copies their ghost exactly never fails.

Empty party slots are filled by bots. The host can make bots react
instantly or like humans, and set a mistake chance so they occasionally
ignore a mechanic.

## How it works

```
src/sim/      Deterministic simulation: timeline, hazards, hit checks, bots
src/data/     Encounters and strategies as plain JSON (edit these, not code)
src/host/     Host side: runs the sim in a Web Worker, relays to peers
src/client/   Each player's view: prediction, interpolation, rendering
src/net/      Transports: PeerJS (default) and same-browser tabs (testing)
```

- The simulation ticks 30 times a second in a **Web Worker** on the host,
  so it keeps running when the host switches tabs.
- Your own character moves instantly. The host judges each mechanic using the
  position **you reported for the resolve tick**, so a dodge that worked on
  your screen counts, even with high ping.
- Other players are drawn about 100 ms behind (plus half your ping) and
  smoothly interpolated.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # simulation unit tests
npm run build        # production build into dist/
npm run test:e2e     # browser tests (needs Chrome); starts a local PeerServer
```

Testing multiplayer without the internet:

- `?net=local` – open two tabs in the same browser; they find each other directly.
- `npm run peer-server`, then use
  `?peerHost=localhost&peerPort=9000&peerPath=/&peerSecure=0` in each window.

## Matchmaking

By default rooms use the free public PeerJS server (0.peerjs.com). It's fine
for testing with friends but has no uptime guarantee. Before sharing the site
publicly:

1. Run your own PeerServer (or a Cloudflare Worker) and point the site at it
   in `src/config.ts`.
2. Add a TURN relay to `DEFAULT_ICE_SERVERS` in
   `src/net/peerjs-transport.ts`. Without it, players behind strict
   firewalls or some mobile networks can't connect.

## Adding an encounter

1. Copy `src/data/encounters/training-dummy.json` and edit the timeline.
2. Copy the strategy file to say where bots stand for each mechanic `key`.
3. Register both in `src/data/index.ts`.

## Deployment

Every push to `main` builds and deploys to GitHub Pages via
`.github/workflows/deploy.yml`.
