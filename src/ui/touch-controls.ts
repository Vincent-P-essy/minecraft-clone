/** On-screen controls for touch devices: a floating left-thumb joystick for
 * movement, a right-side drag surface for looking (quick tap = break), and
 * jump / place buttons. Everything routes into the same controller and
 * interaction the keyboard and mouse drive, so the game itself stays
 * input-agnostic. The joystick math is a pure function so it can be tested
 * without a DOM. */

const JOYSTICK_RADIUS = 56;
const DEAD_ZONE = 0.16;
const SPRINT_THRESHOLD = 0.92;
/** A touch released within this distance/time counts as a tap, not a drag. */
const TAP_MAX_MOVE = 12;
const TAP_MAX_MS = 260;

export interface MoveVector {
  readonly forward: number;
  readonly right: number;
  readonly sprint: boolean;
}

export interface TouchInput {
  readonly forward: number;
  readonly right: number;
  readonly jump: boolean;
  readonly sprint: boolean;
}

/** Maps a thumb offset (pixels from the joystick center) to a movement
 * vector. Applies a dead zone, clamps magnitude to 1, and flags sprint when
 * the stick is pushed near its edge. Up on screen (negative dy) is forward. */
export function joystickVector(dx: number, dy: number, radius = JOYSTICK_RADIUS): MoveVector {
  const nx = dx / radius;
  const ny = dy / radius;
  const mag = Math.hypot(nx, ny);
  if (mag < DEAD_ZONE) return { forward: 0, right: 0, sprint: false };
  const clamped = Math.min(1, mag);
  const scale = clamped / mag;
  return {
    forward: -ny * scale,
    right: nx * scale,
    sprint: clamped >= SPRINT_THRESHOLD,
  };
}

export function isTouchDevice(): boolean {
  return (
    (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) ||
    (typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches)
  );
}

export interface TouchControlHandlers {
  readonly isActive: () => boolean;
  readonly onInput: (input: TouchInput) => void;
  readonly onLook: (pixelsX: number, pixelsY: number) => void;
  readonly onBreak: () => void;
  readonly onPlace: () => void;
}

interface StickTouch {
  readonly kind: "stick";
  readonly cx: number;
  readonly cy: number;
}

interface LookTouch {
  kind: "look";
  lastX: number;
  lastY: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
}

type ActiveTouch = StickTouch | LookTouch;

export class TouchControls {
  private readonly handlers: TouchControlHandlers;
  private readonly stickBase: HTMLDivElement;
  private readonly stickKnob: HTMLDivElement;
  private readonly buttons: HTMLDivElement;
  private readonly touches = new Map<number, ActiveTouch>();

  private move: MoveVector = { forward: 0, right: 0, sprint: false };
  private jumpHeld = false;

  constructor(root: HTMLElement, handlers: TouchControlHandlers) {
    this.handlers = handlers;

    this.stickBase = document.createElement("div");
    this.stickBase.className = "touch-stick-base";
    this.stickBase.style.display = "none";
    this.stickKnob = document.createElement("div");
    this.stickKnob.className = "touch-stick-knob";
    this.stickBase.appendChild(this.stickKnob);

    this.buttons = document.createElement("div");
    this.buttons.className = "touch-buttons";
    this.buttons.append(
      this.makeButton("touch-place", "▣", {
        press: () => {
          if (this.handlers.isActive()) this.handlers.onPlace();
        },
      }),
      this.makeButton("touch-jump", "⤒", {
        press: () => {
          this.jumpHeld = true;
          this.emit();
        },
        release: () => {
          this.jumpHeld = false;
          this.emit();
        },
      }),
    );

    root.append(this.stickBase, this.buttons);

    root.addEventListener("pointerdown", this.onPointerDown, { passive: false });
    root.addEventListener("pointermove", this.onPointerMove, { passive: false });
    root.addEventListener("pointerup", this.onPointerUp);
    root.addEventListener("pointercancel", this.onPointerUp);

    this.setVisible(false);
  }

  /** Reveal or hide the on-screen controls (tied to whether the player has
   * started). Buttons hide when idle so the menu isn't cluttered. */
  setVisible(visible: boolean): void {
    this.buttons.style.display = visible ? "flex" : "none";
    if (!visible) {
      this.stickBase.style.display = "none";
      this.touches.clear();
      this.jumpHeld = false;
      this.move = { forward: 0, right: 0, sprint: false };
      this.emit();
    }
  }

  private makeButton(
    className: string,
    label: string,
    on: { press: () => void; release?: () => void },
  ): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `touch-button ${className}`;
    el.textContent = label;
    el.addEventListener(
      "pointerdown",
      (e) => {
        if (e.pointerType === "mouse") return;
        e.preventDefault();
        e.stopPropagation();
        on.press();
      },
      { passive: false },
    );
    const release = (): void => on.release?.();
    el.addEventListener("pointerup", release);
    el.addEventListener("pointercancel", release);
    return el;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "mouse" || !this.handlers.isActive()) return;
    // Taps on the hotbar (or the buttons, which also stop propagation) must
    // reach their own handlers, not the movement/look surfaces.
    if (e.target instanceof Element && e.target.closest("#hotbar")) return;
    e.preventDefault();
    if (e.clientX < window.innerWidth * 0.45) {
      // Left zone → floating movement joystick, centered where the thumb lands.
      this.touches.set(e.pointerId, { kind: "stick", cx: e.clientX, cy: e.clientY });
      this.stickBase.style.left = `${e.clientX.toString()}px`;
      this.stickBase.style.top = `${e.clientY.toString()}px`;
      this.stickBase.style.display = "block";
      this.moveKnob(0, 0);
    } else {
      this.touches.set(e.pointerId, {
        kind: "look",
        lastX: e.clientX,
        lastY: e.clientY,
        startX: e.clientX,
        startY: e.clientY,
        startTime: performance.now(),
      });
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const touch = this.touches.get(e.pointerId);
    if (!touch) return;
    e.preventDefault();
    if (touch.kind === "stick") {
      let dx = e.clientX - touch.cx;
      let dy = e.clientY - touch.cy;
      const mag = Math.hypot(dx, dy);
      if (mag > JOYSTICK_RADIUS) {
        dx = (dx / mag) * JOYSTICK_RADIUS;
        dy = (dy / mag) * JOYSTICK_RADIUS;
      }
      this.moveKnob(dx, dy);
      this.move = joystickVector(dx, dy);
      this.emit();
    } else {
      this.handlers.onLook(e.clientX - touch.lastX, e.clientY - touch.lastY);
      touch.lastX = e.clientX;
      touch.lastY = e.clientY;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const touch = this.touches.get(e.pointerId);
    if (!touch) return;
    this.touches.delete(e.pointerId);
    if (touch.kind === "stick") {
      this.stickBase.style.display = "none";
      this.move = { forward: 0, right: 0, sprint: false };
      this.emit();
    } else {
      const moved = Math.hypot(e.clientX - touch.startX, e.clientY - touch.startY);
      const elapsed = performance.now() - touch.startTime;
      if (moved <= TAP_MAX_MOVE && elapsed <= TAP_MAX_MS && this.handlers.isActive()) {
        this.handlers.onBreak();
      }
    }
  };

  private moveKnob(dx: number, dy: number): void {
    this.stickKnob.style.transform = `translate(${dx.toString()}px, ${dy.toString()}px)`;
  }

  private emit(): void {
    this.handlers.onInput({
      forward: this.move.forward,
      right: this.move.right,
      jump: this.jumpHeld,
      sprint: this.move.sprint,
    });
  }
}
