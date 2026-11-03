import "./style.css";
import { ClientSession, type FeedItem } from "./client/client-session";
import type { View } from "./client/view";
import { upcomingStep, type CompiledStep } from "./sim/strategy";
import { View2D } from "./client/view2d";
import { TimelineBar } from "./client/timeline";
import { transportFromUrl } from "./config";
import { DEFAULT_ENCOUNTER_ID, ENCOUNTERS } from "./data";
import { HostSession, linkFromConnection, type Link } from "./host/host-session";
import { netStats } from "./net/transport";
import { DEFAULT_BOT_SETTINGS, type BotSettings } from "./sim/bots";
import { SLOTS, roleOf, type Vec2 } from "./sim/types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const transport = transportFromUrl(params);
// Encounter picker ------------------------------------------------------------
const encounterSelect = $<HTMLSelectElement>("encounter");
for (const [id, e] of Object.entries(ENCOUNTERS)) encounterSelect.append(new Option(e.def.name, id));
try {
  const saved = localStorage.getItem("gms-encounter");
  if (saved && ENCOUNTERS[saved]) encounterSelect.value = saved;
} catch {
  /* ignore */
}
const chosenEncounter = () => ENCOUNTERS[encounterSelect.value] ?? ENCOUNTERS[DEFAULT_ENCOUNTER_ID];
const showSource = () => {
  const src = chosenEncounter().def.source;
  const el = $("encounter-source");
  el.replaceChildren();
  if (!src) return;
  el.append("Based on ");
  if (src.url) {
    const a = document.createElement("a");
    a.href = src.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = src.title;
    el.append(a);
  } else el.append(src.title);
  if (src.author) el.append(` by ${src.author}`);
  el.append(". ");
  if (src.caveat) el.append(src.caveat);
};
encounterSelect.addEventListener("change", () => {
  try {
    localStorage.setItem("gms-encounter", encounterSelect.value);
  } catch {
    /* ignore */
  }
  showSource();
});
showSource();

// ----------------------------------------------------------------------------
// Lobby
// ----------------------------------------------------------------------------

const nameInput = $<HTMLInputElement>("name");
const codeInput = $<HTMLInputElement>("code");
const status = $("lobby-status");

$("transport-name").textContent = transport.name;

try {
  nameInput.value = localStorage.getItem("gms-name") ?? "";
} catch {
  /* storage unavailable: fine */
}
if (params.get("room")) codeInput.value = params.get("room")!.toUpperCase();

function playerName(): string {
  const n = nameInput.value.trim() || "Player";
  try {
    localStorage.setItem("gms-name", n);
  } catch {
    /* ignore */
  }
  return n;
}

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle("error", error);
}

function busy(on: boolean): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>("#lobby button")) b.disabled = on;
}

const hostOpts = () => ({
  name: playerName(),
  encounterId: chosenEncounter().def.id,
  strategyId: chosenEncounter().strategies[0].id,
  bots: { ...DEFAULT_BOT_SETTINGS },
});

$("solo").addEventListener("click", async () => {
  busy(true);
  const host = new HostSession(null, hostOpts());
  startGame(await host.start(), host);
});

$("create").addEventListener("click", async () => {
  busy(true);
  setStatus("Creating room…");
  const host = new HostSession(transport, hostOpts());
  try {
    const link = await host.start();
    startGame(link, host);
  } catch (err) {
    host.stop();
    setStatus((err as Error).message, true);
    busy(false);
  }
});

$("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = codeInput.value.trim();
  if (!code) {
    setStatus("Enter the room code your host shared.", true);
    codeInput.focus();
    return;
  }
  busy(true);
  setStatus(`Joining ${code.toUpperCase()}…`);
  try {
    const conn = await transport.joinRoom(code);
    startGame(linkFromConnection(conn), null);
  } catch (err) {
    setStatus((err as Error).message, true);
    busy(false);
  }
});

// ----------------------------------------------------------------------------
// Game
// ----------------------------------------------------------------------------

function startGame(link: Link, host: HostSession | null): void {
  const client = new ClientSession(link, playerName(), host !== null);
  (window as unknown as { gms: unknown }).gms = { client, host };

  client.onFull = (reason) => {
    setStatus(reason, true);
    busy(false);
  };
  client.onReady = () => {
    $("lobby").hidden = true;
    $("game").hidden = false;
    setupGame(client, host);
  };
  client.onDisconnect = () => {
    if ($("game").hidden) return;
    showToast("Lost connection to the host.", 4000);
    setTimeout(() => leave(), 2500);
  };
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(text: string, ms = 1800): void {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

function leave(): void {
  const keep = new URLSearchParams(location.search);
  keep.delete("room");
  const q = keep.toString();
  location.href = location.pathname + (q ? `?${q}` : "");
}

function inviteLink(code: string): string {
  const q = new URLSearchParams(location.search);
  q.set("room", code);
  return `${location.origin}${location.pathname}?${q}`;
}

function setupGame(client: ClientSession, host: HostSession | null): void {
  // Views: 2D top-down and 3D. The 3D code (Three.js) loads on first use.
  const view2d = new View2D($<HTMLCanvasElement>("arena"));
  let view3d: View | undefined;
  let view: View = view2d;
  let showGhost = true;
  const viewButtons = document.querySelectorAll<HTMLButtonElement>("[data-view]");
  const setView = async (kind: "2d" | "3d") => {
    if (kind === "3d" && !view3d) {
      try {
        const { View3D } = await import("./client/view3d");
        view3d = new View3D($<HTMLCanvasElement>("arena3d"), $("arena-wrap"));
      } catch (err) {
        console.error(err);
        showToast("3D isn't available in this browser (WebGL is off). Showing 2D.", 4000);
        kind = "2d";
      }
    }
    view = kind === "3d" && view3d ? view3d : view2d;
    view2d.setVisible(view === view2d);
    view3d?.setVisible(view === view3d);
    view.showGhost = showGhost;
    for (const b of viewButtons) b.setAttribute("aria-pressed", String(b.dataset.view === view.kind));
    $("hint-3d").hidden = view.kind !== "3d";
    try {
      localStorage.setItem("gms-view", view.kind);
    } catch {
      /* ignore */
    }
  };
  for (const b of viewButtons) b.addEventListener("click", () => void setView(b.dataset.view as "2d" | "3d"));
  let savedView: string | null = null;
  try {
    savedView = localStorage.getItem("gms-view");
  } catch {
    /* ignore */
  }
  void setView(savedView === "2d" ? "2d" : "3d");
  // Handy for debugging in the console (and used by the browser tests).
  Object.assign((window as unknown as { gms: object }).gms, { view: () => view, setView });

  // Pause -------------------------------------------------------------------------
  const pauseBtn = $<HTMLButtonElement>("pause");
  const togglePause = () => {
    if (!host) {
      showToast("Only the host can pause.");
      return;
    }
    host.setPaused(!client.paused);
  };
  const showPaused = (paused: boolean) => {
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    pauseBtn.setAttribute("aria-pressed", String(paused));
    $("paused-banner").hidden = !paused;
    $("paused-who").textContent = host ? "Press Space or Resume to continue." : "The host paused the encounter.";
  };
  pauseBtn.addEventListener("click", togglePause);
  if (!host) pauseBtn.disabled = true;
  client.onPause = (paused) => {
    showPaused(paused);
    keys.clear();
  };
  showPaused(client.paused);

  // Room code -----------------------------------------------------------------
  if (host?.room) {
    const code = host.room.code;
    $("room-box").hidden = false;
    $("room-code").textContent = code;
    $("room-code").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(inviteLink(code));
        $("room-hint").textContent = "Invite link copied";
      } catch {
        $("room-hint").textContent = inviteLink(code);
      }
    });
    host.onRoomError = (e) => showToast(e, 5000);
  }

  // Timeline ------------------------------------------------------------------
  const timeline = new TimelineBar(
    $("timeline"),
    client.encounter,
    host !== null,
    (seconds) => host?.seek(seconds),
    () => showToast("Only the host can move the timeline."),
  );
  client.onSeek = (seconds) => {
    const li = document.createElement("li");
    li.className = "note";
    const s = Math.floor(seconds);
    li.textContent = `Jumped to ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    $("feed").prepend(li);
  };

  // Strategy steps ----------------------------------------------------------------
  const steps = client.strategy?.steps;
  let shownStep: CompiledStep | undefined;
  const updateStep = () => {
    if (!steps?.length) return;
    const step = upcomingStep(steps, client.loopTime());
    if (step === shownStep) return;
    shownStep = step;
    $("step-label").textContent = step ? step.label : "";
    $("step-note").textContent = step?.note ?? "";
  };
  if (steps?.length) {
    $("strategy-panel").hidden = false;
    const src = ENCOUNTERS[client.encounter.id].strategies.find((x) => x.id === client.strategy?.id)?.source;
    const el = $("strategy-source");
    if (src?.url) {
      const a = document.createElement("a");
      a.href = src.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `${src.title}${src.author ? ` by ${src.author}` : ""}`;
      el.append("Strategy: ", a);
    }
  }

  // Ghost -----------------------------------------------------------------------
  const ghostToggle = $<HTMLInputElement>("ghost-toggle");
  try {
    ghostToggle.checked = localStorage.getItem("gms-ghost") !== "off";
  } catch {
    /* ignore */
  }
  const applyGhost = () => {
    showGhost = ghostToggle.checked;
    view.showGhost = showGhost;
    try {
      localStorage.setItem("gms-ghost", ghostToggle.checked ? "on" : "off");
    } catch {
      /* ignore */
    }
  };
  ghostToggle.addEventListener("change", applyGhost);
  applyGhost();

  // Bot settings ----------------------------------------------------------------
  const diff = $<HTMLSelectElement>("bot-difficulty");
  const mistakes = $<HTMLInputElement>("bot-mistakes");
  const mistakeOut = $("mistake-out");
  const showBots = (b: BotSettings) => {
    diff.value = b.difficulty;
    mistakes.value = String(Math.round(b.mistakeChance * 100));
    mistakeOut.textContent = `${mistakes.value}%`;
  };
  showBots(client.bots);
  if (host) {
    const apply = () => {
      mistakeOut.textContent = `${mistakes.value}%`;
      host.setBots({ difficulty: diff.value as BotSettings["difficulty"], mistakeChance: Number(mistakes.value) / 100 });
    };
    diff.addEventListener("change", apply);
    mistakes.addEventListener("input", apply);
  } else {
    diff.disabled = true;
    mistakes.disabled = true;
    $("bot-note").hidden = false;
    client.onBots = () => showBots(client.bots);
  }

  // Roster ----------------------------------------------------------------------
  const rosterEl = $("roster");
  const renderRoster = () => {
    const rows = [...client.players.values()].sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
    rosterEl.replaceChildren(
      ...rows.map((p) => {
        const li = document.createElement("li");
        const slot = document.createElement("span");
        slot.className = `slot ${roleOf(p.slot)}`;
        slot.textContent = p.slot;
        const name = document.createElement("span");
        name.textContent = p.isBot ? "Bot" : p.name + (p.id === client.myId ? " (you)" : "");
        name.className = p.isBot ? "bot" : p.id === client.myId ? "me" : "";
        const ping = document.createElement("span");
        ping.className = "ping";
        const ms = client.pings[p.id];
        ping.textContent = p.isBot ? "" : p.id === "host" ? "host" : ms !== undefined ? `${ms} ms` : "";
        const fails = document.createElement("span");
        fails.className = `fails${p.fails ? " has" : ""}`;
        fails.textContent = `${p.fails} ✕`;
        fails.title = "Mechanics failed";
        li.append(slot, name, ping, fails);
        return li;
      }),
    );
  };
  client.onRoster = renderRoster;
  renderRoster();
  setInterval(renderRoster, 1000);

  // Feed ------------------------------------------------------------------------
  const feedEl = $("feed");
  client.onFeed = (item: FeedItem) => {
    const li = document.createElement("li");
    li.textContent = item.text;
    if (!item.ok) li.classList.add("bad");
    if (item.mine) li.classList.add("mine");
    feedEl.prepend(li);
    while (feedEl.children.length > 30) feedEl.lastElementChild?.remove();
    if (item.mine) showToast(`You failed ${item.text.split(":")[0]}`);
  };

  // Input -----------------------------------------------------------------------
  const keys = new Set<string>();
  window.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).matches("input, select, textarea")) return;
    if (e.key === "`") {
      $("debug").hidden = !$("debug").hidden;
      return;
    }
    if (e.key === "g" || e.key === "G") {
      ghostToggle.checked = !ghostToggle.checked;
      applyGhost();
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (!e.repeat) togglePause();
      return;
    }
    if (e.key === "v" || e.key === "V") {
      void setView(view.kind === "3d" ? "2d" : "3d");
      return;
    }
    keys.add(e.key.toLowerCase());
    if (e.key.startsWith("Arrow")) e.preventDefault();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener("blur", () => keys.clear());

  const inputDir = (): Vec2 => {
    let x = 0;
    let y = 0;
    if (keys.has("a") || keys.has("arrowleft")) x -= 1;
    if (keys.has("d") || keys.has("arrowright")) x += 1;
    if (keys.has("w") || keys.has("arrowup")) y -= 1;
    if (keys.has("s") || keys.has("arrowdown")) y += 1;
    return x || y ? view.toWorldInput({ x, y }) : { x: 0, y: 0 };
  };

  $("leave").addEventListener("click", () => {
    client.close();
    host?.stop();
    leave();
  });

  // Debug overlay -----------------------------------------------------------------
  let frames = 0;
  let lastOut = netStats.bytesOut;
  let lastIn = netStats.bytesIn;
  let fps = 0;
  let upKBs = 0;
  let downKBs = 0;
  setInterval(() => {
    fps = frames;
    frames = 0;
    upKBs = (netStats.bytesOut - lastOut) / 1024;
    downKBs = (netStats.bytesIn - lastIn) / 1024;
    lastOut = netStats.bytesOut;
    lastIn = netStats.bytesIn;
    const lines = [
      `fps          ${fps}`,
      `ping         ${host ? "0 (you are host)" : `${Math.round(client.rtt)} ms`}`,
      `upload       ${upKBs.toFixed(1)} KB/s`,
      `download     ${downKBs.toFixed(1)} KB/s`,
      `network      ${host && !host.room ? "offline (solo)" : transport.name}`,
    ];
    if (host) {
      lines.push(
        `sim ticks/s  ${host.stats.ticksPerSec}`,
        `sim step     ${host.stats.avgStepMs.toFixed(3)} ms avg, ${host.stats.maxStepMs.toFixed(3)} ms max`,
        `peers        ${host.stats.peers}`,
      );
    }
    $("debug").textContent = lines.join("\n");
  }, 1000);

  // Frame loop --------------------------------------------------------------------
  const castbar = $("castbar");
  const castName = $("cast-name");
  const castTime = $("cast-time");
  const castFill = $("cast-fill");
  let last = performance.now();
  const frame = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    frames++;
    client.update(dt, inputDir());
    view.draw(client);
    timeline.update(client.loopTime());
    updateStep();
    const cast = client.currentCast();
    castbar.hidden = !cast;
    if (cast) {
      castName.textContent = cast.name;
      castTime.textContent = `${cast.secondsLeft.toFixed(1)}s`;
      castFill.style.width = `${Math.min(100, cast.progress * 100)}%`;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
