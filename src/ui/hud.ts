const REPORT_INTERVAL_MS = 300;

export interface HudInfo {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly chunks: number;
  readonly seed: number;
  /** Extra trailing detail, e.g. the render tier and scale. */
  readonly note?: string;
}

/** The debug line (fps, position, chunk count, seed) and the little toast
 * that names things — the block just selected, a mode just toggled. */
export class Hud {
  private readonly stats: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  private frames = 0;
  private lastReport = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** Frames per second over the last report window. */
  fps = 0;

  constructor(parent: HTMLElement) {
    this.stats = document.createElement("div");
    this.stats.id = "fps";
    this.toast = document.createElement("div");
    this.toast.id = "toast";
    parent.append(this.stats, this.toast);
  }

  setStatsVisible(visible: boolean): void {
    this.stats.style.display = visible ? "block" : "none";
  }

  /** Shows a short message above the hotbar for a moment. */
  announce(message: string): void {
    this.toast.textContent = message;
    this.toast.classList.add("visible");
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.classList.remove("visible");
    }, 1400);
  }

  frame(nowMs: number, info: HudInfo): void {
    this.frames++;
    if (nowMs - this.lastReport < REPORT_INTERVAL_MS) return;
    this.fps = Math.round((this.frames * 1000) / (nowMs - this.lastReport));
    this.frames = 0;
    this.lastReport = nowMs;
    const pos = `${Math.floor(info.x).toString()}, ${Math.floor(info.y).toString()}, ${Math.floor(info.z).toString()}`;
    const note = info.note ? ` · ${info.note}` : "";
    this.stats.textContent = `${this.fps.toString()} fps · (${pos}) · ${info.chunks.toString()} chunks · seed ${info.seed.toString()}${note}`;
  }
}
