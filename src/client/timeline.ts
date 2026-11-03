import type { EncounterDef, TimelineEntry } from "../sim/types";

const fmt = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** How far before a cast a mechanic's name button jumps, so you have time to get ready. */
const PREP_SECONDS = 2;

function kindClass(e: TimelineEntry): string {
  const t = e.mechanic.type;
  return t === "stack" ? "k-stack" : t === "spread" ? "k-spread" : "k-aoe";
}

/**
 * Overview of one encounter loop: every cast as a block, a playhead for
 * "now", and click-to-jump for the host.
 */
export class TimelineBar {
  private readonly track: HTMLElement;
  private readonly playhead: HTMLElement;
  private readonly hover: HTMLElement;
  private readonly blocks: { el: HTMLElement; label: HTMLElement; entry: TimelineEntry }[] = [];
  private readonly loop: number;

  constructor(
    root: HTMLElement,
    enc: EncounterDef,
    private readonly canSeek: boolean,
    private readonly onSeek: (seconds: number) => void,
    private readonly onDenied: () => void,
  ) {
    this.loop = enc.loopLength;
    const pct = (sec: number) => `${(sec / this.loop) * 100}%`;
    root.classList.toggle("tl-readonly", !canSeek);
    root.replaceChildren();

    // Mechanic names, each spanning the gap until the next cast.
    const labels = document.createElement("div");
    labels.className = "tl-labels";
    const track = document.createElement("div");
    track.className = "tl-track";
    track.tabIndex = 0;
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", "Encounter timeline");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(this.loop));

    enc.timeline.forEach((entry, i) => {
      const next = enc.timeline[i + 1]?.at ?? this.loop;
      const label = document.createElement("button");
      label.type = "button";
      label.className = `tl-label ${kindClass(entry)}`;
      label.style.left = pct(entry.at);
      label.style.width = pct(next - entry.at);
      label.textContent = entry.mechanic.name;
      label.title = canSeek
        ? `${entry.mechanic.name} at ${fmt(entry.at)}. Click to jump to ${PREP_SECONDS} s before it.`
        : `${entry.mechanic.name} at ${fmt(entry.at)}`;
      label.addEventListener("click", () => this.request(Math.max(0, entry.at - PREP_SECONDS)));
      labels.append(label);

      const block = document.createElement("div");
      block.className = `tl-block ${kindClass(entry)}`;
      block.style.left = pct(entry.at);
      block.style.width = pct(entry.cast);
      track.append(block);
      this.blocks.push({ el: block, label, entry });
    });

    this.playhead = document.createElement("div");
    this.playhead.className = "tl-playhead";
    this.hover = document.createElement("div");
    this.hover.className = "tl-hover";
    this.hover.hidden = true;
    track.append(this.playhead, this.hover);

    const scale = document.createElement("div");
    scale.className = "tl-scale";
    for (let s = 0; s < this.loop; s += 10) {
      const t = document.createElement("span");
      t.style.left = pct(s);
      t.textContent = fmt(s);
      scale.append(t);
    }

    root.append(labels, track, scale);
    this.track = track;

    const timeAt = (clientX: number) => {
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * this.loop;
    };
    track.addEventListener("pointermove", (e) => {
      const t = timeAt(e.clientX);
      this.hover.hidden = false;
      this.hover.style.left = pct(t);
      this.hover.textContent = this.canSeek ? `Jump to ${fmt(t)}` : fmt(t);
    });
    track.addEventListener("pointerleave", () => (this.hover.hidden = true));
    track.addEventListener("click", (e) => this.request(timeAt(e.clientX)));
    track.addEventListener("keydown", (e) => {
      const now = Number(track.getAttribute("aria-valuenow") ?? 0);
      if (e.key === "ArrowLeft") this.request(Math.max(0, now - 5));
      else if (e.key === "ArrowRight") this.request(Math.min(this.loop - 0.1, now + 5));
      else if (e.key === "Home") this.request(0);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  private request(seconds: number): void {
    if (this.canSeek) this.onSeek(seconds);
    else this.onDenied();
  }

  /** Move the playhead; `loopTime` is negative during the lead-in. */
  update(loopTime: number): void {
    const t = Math.max(0, loopTime);
    this.playhead.style.left = `${(t / this.loop) * 100}%`;
    this.track.setAttribute("aria-valuenow", t.toFixed(1));
    this.track.setAttribute("aria-valuetext", fmt(t));
    for (const b of this.blocks) {
      const active = t >= b.entry.at && t < b.entry.at + b.entry.cast;
      const done = loopTime >= 0 && t >= b.entry.at + b.entry.cast;
      b.el.classList.toggle("active", active);
      b.el.classList.toggle("done", done);
      b.label.classList.toggle("active", active);
      b.label.classList.toggle("done", done);
    }
  }
}
