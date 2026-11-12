/** Controller support (Xbox / PlayStation / Switch pads, Steam Deck): the
 * standard Gamepad mapping, polled once a frame and turned into the same
 * small input surface the keyboard, mouse and touch controls drive.
 *
 *   left stick   move (click to sprint)     right stick   look
 *   A            jump (twice: fly)          B             descend
 *   RT           break                      LT            place
 *   LB / RB      previous / next block      Y             inventory
 *   X            toggle flight              Start         pause / resume
 */

const DEAD_ZONE = 0.18;
/** Look speed at full stick deflection, in "pixels of drag" per second. */
const LOOK_SPEED = 560;
/** Hold-to-repeat cadence for the triggers, matching the mouse. */
const REPEAT_SECONDS = 0.23;
const TRIGGER_THRESHOLD = 0.45;

/** Removes the dead zone and rescales what's left to the full 0..1 range,
 * so there's no jump in speed at the edge of the zone. */
export function applyDeadZone(value: number, deadZone = DEAD_ZONE): number {
  const magnitude = Math.abs(value);
  if (magnitude <= deadZone) return 0;
  return (Math.sign(value) * (Math.min(1, magnitude) - deadZone)) / (1 - deadZone);
}

/** A stick as a 2D vector with a circular dead zone, length capped at 1. */
export function stickVector(x: number, y: number, deadZone = DEAD_ZONE): { x: number; y: number } {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= deadZone) return { x: 0, y: 0 };
  const scaled = (Math.min(1, magnitude) - deadZone) / (1 - deadZone);
  return { x: (x / magnitude) * scaled, y: (y / magnitude) * scaled };
}

/** Squares the deflection (keeping its sign): fine aim near the center,
 * full speed at the rim. */
export function lookCurve(value: number): number {
  return value * Math.abs(value);
}

export interface PadFrame {
  /** -1..1, positive = forward / right. */
  readonly forward: number;
  readonly right: number;
  /** Look deltas for this frame, in pixels of drag. */
  readonly lookX: number;
  readonly lookY: number;
  readonly jump: boolean;
  readonly descend: boolean;
  readonly sprint: boolean;
  /** One-shot actions that fired this frame. */
  readonly breakBlock: boolean;
  readonly placeBlock: boolean;
  readonly hotbarStep: -1 | 0 | 1;
  readonly inventory: boolean;
  readonly toggleFlight: boolean;
  readonly pause: boolean;
  /** Whether the pad is being touched at all right now. */
  readonly active: boolean;
}

/** The slice of the Gamepad API this module reads — injectable for tests. */
export interface PadSnapshot {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

export class GamepadInput {
  private readonly previous: boolean[] = [];
  private breakTimer = 0;
  private placeTimer = 0;
  private sprintLatched = false;

  /** Turns one snapshot of the pad into this frame's actions. */
  read(pad: PadSnapshot, dt: number): PadFrame {
    const axis = (i: number): number => pad.axes[i] ?? 0;
    const held = (i: number): boolean => {
      const button = pad.buttons[i];
      return button !== undefined && (button.pressed || button.value > TRIGGER_THRESHOLD);
    };
    const pressed = (i: number): boolean => held(i) && this.previous[i] !== true;

    const move = stickVector(axis(0), axis(1));
    const look = stickVector(axis(2), axis(3));

    // Clicking the left stick latches sprint until the stick is released.
    if (pressed(10)) this.sprintLatched = true;
    if (move.x === 0 && move.y === 0) this.sprintLatched = false;

    // Triggers act at once, then repeat while held.
    const repeat = (down: boolean, timer: number): [boolean, number] => {
      if (!down) return [false, 0];
      if (timer <= 0) return [true, REPEAT_SECONDS];
      return [false, timer - dt];
    };
    const [breakBlock, breakTimer] = repeat(held(7), this.breakTimer);
    const [placeBlock, placeTimer] = repeat(held(6), this.placeTimer);
    this.breakTimer = breakTimer;
    this.placeTimer = placeTimer;

    const frame: PadFrame = {
      forward: 0 - move.y,
      right: move.x,
      lookX: lookCurve(look.x) * LOOK_SPEED * dt,
      lookY: lookCurve(look.y) * LOOK_SPEED * dt * 0.8,
      jump: held(0),
      descend: held(1),
      sprint: this.sprintLatched,
      breakBlock,
      placeBlock,
      hotbarStep: pressed(5) ? 1 : pressed(4) ? -1 : 0,
      inventory: pressed(3),
      toggleFlight: pressed(2),
      pause: pressed(9),
      active:
        move.x !== 0 ||
        move.y !== 0 ||
        look.x !== 0 ||
        look.y !== 0 ||
        pad.buttons.some((b, i) => i < 16 && (b.pressed || b.value > TRIGGER_THRESHOLD)),
    };

    for (let i = 0; i < pad.buttons.length; i++) this.previous[i] = held(i);
    return frame;
  }

  /** Reads the first connected standard-mapping pad, if any. */
  poll(dt: number): PadFrame | null {
    if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
      return null;
    }
    let pads: (Gamepad | null)[];
    try {
      pads = navigator.getGamepads();
    } catch {
      return null; // blocked by a permissions policy
    }
    for (const pad of pads) {
      if (pad?.connected && pad.mapping === "standard") return this.read(pad, dt);
    }
    return null;
  }
}
