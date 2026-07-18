const REPORT_INTERVAL_MS = 250;

export interface HudInfo {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly chunks: number;
  readonly seed: number;
  /** Extra trailing detail, e.g. "cpu renderer" when WebGL is unavailable. */
  readonly note?: string;
}

/** The little monospace status line: fps, position, chunk count, seed. */
export class Hud {
  private readonly el: HTMLDivElement;
  private frames = 0;
  private lastReport = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.id = "fps";
    parent.appendChild(this.el);
  }

  frame(nowMs: number, info: HudInfo): void {
    this.frames++;
    if (nowMs - this.lastReport < REPORT_INTERVAL_MS) return;
    const fps = Math.round((this.frames * 1000) / (nowMs - this.lastReport));
    this.frames = 0;
    this.lastReport = nowMs;
    const pos = `${Math.floor(info.x).toString()}, ${Math.floor(info.y).toString()}, ${Math.floor(info.z).toString()}`;
    const note = info.note ? ` · ${info.note}` : "";
    this.el.textContent = `${fps.toString()} fps · (${pos}) · ${info.chunks.toString()} chunks · seed ${info.seed.toString()}${note}`;
  }
}
