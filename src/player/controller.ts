import * as THREE from "three";
import { BlockId, isSolid } from "../world/blocks";
import { CHUNK_HEIGHT } from "../world/coords";
import type { World } from "../world/world";
import {
  findGroundHeight,
  forwardVector,
  MOVE_SPEED,
  PLAYER_EYE_HEIGHT,
  type PlayerPhysicsState,
  rightVector,
  stepFlight,
  stepPhysics,
  type Vec3,
  waterRegime,
} from "./physics";

const MOUSE_SENSITIVITY = 0.0022;
const DRAG_SENSITIVITY = 0.0035;
const MAX_PITCH = Math.PI / 2 - 0.01;
/** How long to wait for pointerlockchange before deciding the browser
 * refused (silently, as some do) and falling back to drag-look. */
const POINTER_LOCK_WATCHDOG_MS = 600;

/** Physics advances in fixed steps and the camera interpolates between
 * the last two: motion is identical at 30, 60 or 144 Hz, and a frame that
 * arrives a little early or late doesn't show up as a stutter. */
const TICK = 1 / 120;
const MAX_TICKS_PER_FRAME = 12;
/** How quickly movement input ramps up and coasts down (1/seconds). */
const INPUT_ATTACK = 14;
const INPUT_RELEASE = 11;
const DOUBLE_TAP_MS = 280;
const STEP_DISTANCE = 2.1;

type Action = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "descend";

/** Bound by physical key position, so WASD is ZQSD on an AZERTY keyboard
 * without any configuration. */
const KEY_BINDINGS: Record<string, Action> = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  ArrowUp: "forward",
  ArrowDown: "back",
  ArrowLeft: "left",
  ArrowRight: "right",
  Space: "jump",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
  ControlLeft: "descend",
  KeyC: "descend",
};

export type ControlMode = "idle" | "pointer" | "drag";

export interface ControlOptions {
  sensitivity: number;
  invertY: boolean;
  autoJump: boolean;
  viewBob: boolean;
  fov: number;
}

export interface ExternalInput {
  forward: number;
  right: number;
  jump: boolean;
  sprint: boolean;
  descend?: boolean;
}

export interface SavedPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flying: boolean;
}

/** Things that happened to the player this frame, for sound and particles. */
export interface PlayerEvents {
  onStep?: (blockBelow: BlockId) => void;
  onJump?: () => void;
  onLand?: (fallSpeed: number, blockBelow: BlockId) => void;
  onSplash?: (entering: boolean) => void;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Pointer-lock FPS movement with a graceful degradation path: if the
 * browser never grants pointer lock (extensions, permissions, embedded
 * contexts — it happens, silently), the game switches to drag-to-look
 * instead of leaving a dead "Click to play" button. The overlay/DOM dance
 * and key tracking live here because they're inherently browser glue; the
 * actual physics is pure and tested separately. */
export class PlayerController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private readonly overlay: HTMLElement | null;
  private readonly world: World;
  readonly options: ControlOptions;
  events: PlayerEvents = {};

  private state: PlayerPhysicsState;
  private previous: Vec3;
  private accumulator = 0;
  private yaw = 0;
  private pitch = 0;
  private readonly pressed = new Set<string>();
  private controlMode: ControlMode = "idle";
  private dragging = false;
  private lockWatchdog: ReturnType<typeof setTimeout> | undefined;
  private external: ExternalInput | null = null;

  private flying = false;
  private lastJumpTap = 0;
  private jumpWasDown = false;
  private smoothForward = 0;
  private smoothRight = 0;
  private wasOnGround = false;
  private wasInWater = false;
  private fallSpeed = 0;
  private stepTravel = 0;

  // Camera feel.
  private bobPhase = 0;
  private bobAmount = 0;
  private landDip = 0;
  private fovKick = 0;
  /** Whether the player may move (false while a menu is open). */
  inputEnabled = true;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    world: World,
    spawnX = 8,
    spawnZ = 8,
    options?: Partial<ControlOptions>,
  ) {
    this.camera = camera;
    this.camera.rotation.order = "YXZ";
    this.domElement = domElement;
    this.overlay = document.querySelector("#overlay");
    this.world = world;
    this.options = {
      sensitivity: 1,
      invertY: false,
      autoJump: false,
      viewBob: true,
      fov: 75,
      ...options,
    };

    const groundY = findGroundHeight(
      Math.floor(spawnX),
      Math.floor(spawnZ),
      CHUNK_HEIGHT - 1,
      this.solidAt,
    );
    this.state = {
      position: { x: spawnX, y: groundY, z: spawnZ },
      velocity: { x: 0, y: 0, z: 0 },
      onGround: false,
    };
    this.previous = this.state.position;

    this.bindEvents();
    this.syncCamera(0);
  }

  private readonly solidAt = (x: number, y: number, z: number): boolean =>
    isSolid(this.world.getBlock(x, y, z));

  private readonly waterAt = (x: number, y: number, z: number): boolean =>
    this.world.getBlock(x, y, z) === BlockId.WATER;

  private enterMode(mode: ControlMode): void {
    this.controlMode = mode;
    this.overlay?.classList.toggle("hidden", mode !== "idle");
    if (mode === "idle") {
      this.pressed.clear();
      this.onPause?.();
    } else {
      this.onResume?.();
    }
  }

  onPause: (() => void) | undefined;
  onResume: (() => void) | undefined;

  private bindEvents(): void {
    const playButton = document.querySelector<HTMLButtonElement>("#play-button");
    playButton?.addEventListener("click", () => {
      this.requestControl();
    });

    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === this.domElement;
      if (locked) {
        if (this.lockWatchdog) clearTimeout(this.lockWatchdog);
        this.enterMode("pointer");
      } else if (this.controlMode === "pointer" && !this.uiOpen) {
        this.enterMode("idle");
      }
    });

    document.addEventListener("mousemove", (e) => {
      if (this.controlMode === "pointer") {
        this.applyLook(e.movementX, e.movementY, MOUSE_SENSITIVITY);
      } else if (this.controlMode === "drag" && this.dragging) {
        this.applyLook(e.movementX, e.movementY, DRAG_SENSITIVITY);
      }
    });

    this.domElement.addEventListener("mousedown", (e) => {
      if (this.controlMode === "drag" && e.button === 0) this.dragging = true;
    });
    document.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.dragging = false;
    });

    document.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && this.controlMode === "drag") {
        this.enterMode("idle");
        return;
      }
      if (this.controlMode !== "idle" && !e.repeat) {
        if (e.code === "KeyF") this.toggleFlight();
        if (e.code === "Space") this.registerJumpTap();
      }
      this.pressed.add(e.code);
      // The page must not scroll or focus-hop while playing.
      if (
        this.controlMode !== "idle" &&
        (e.code === "Space" || e.code.startsWith("Arrow") || e.code === "Tab")
      ) {
        e.preventDefault();
      }
    });
    document.addEventListener("keyup", (e) => {
      this.pressed.delete(e.code);
    });
    window.addEventListener("blur", () => {
      this.pressed.clear();
      this.dragging = false;
    });

    this.domElement.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });
  }

  /** Two quick presses of jump toggle flight, like every creative mode. */
  private registerJumpTap(): void {
    const now = performance.now();
    if (now - this.lastJumpTap < DOUBLE_TAP_MS) {
      this.toggleFlight();
      this.lastJumpTap = 0;
    } else {
      this.lastJumpTap = now;
    }
  }

  /** Adventure mode keeps both feet on the ground. */
  flightAllowed = true;

  /** Turns flight on or off for the current game mode. */
  setFlightAllowed(allowed: boolean): void {
    this.flightAllowed = allowed;
    if (!allowed && this.flying) this.toggleFlight(true);
  }

  toggleFlight(force = false): void {
    if (!this.flightAllowed && !this.flying && !force) return;
    this.flying = !this.flying;
    this.state = { ...this.state, velocity: { x: 0, y: 0, z: 0 } };
    this.onFlightChange?.(this.flying);
  }

  onFlightChange: ((flying: boolean) => void) | undefined;

  /** Ask for pointer lock; if the browser quietly never grants it, fall
   * back to drag-look so the game starts regardless. Touch-first devices
   * skip the pointer-lock dance entirely — there is no pointer to lock. */
  requestControl(): void {
    if (window.matchMedia("(pointer: coarse)").matches) {
      this.enterMode("drag");
      return;
    }
    if (this.lockWatchdog) clearTimeout(this.lockWatchdog);
    this.lockWatchdog = setTimeout(() => {
      if (this.controlMode === "idle") this.enterMode("drag");
    }, POINTER_LOCK_WATCHDOG_MS);

    try {
      // Returns a promise in Chromium, undefined elsewhere; a rejection
      // means the watchdog path takes over immediately.
      const result: unknown = this.domElement.requestPointerLock();
      if (result instanceof Promise) {
        result.catch(() => {
          if (this.lockWatchdog) clearTimeout(this.lockWatchdog);
          if (this.controlMode === "idle") this.enterMode("drag");
        });
      }
    } catch {
      if (this.lockWatchdog) clearTimeout(this.lockWatchdog);
      this.enterMode("drag");
    }
  }

  private uiOpen = false;

  /** Frees the pointer for an in-game panel (the inventory) without
   * pausing: the world keeps running, the player just stops steering. */
  openUi(): void {
    if (this.controlMode === "idle" || this.uiOpen) return;
    this.uiOpen = true;
    this.inputEnabled = false;
    this.pressed.clear();
    if (this.controlMode === "pointer") document.exitPointerLock();
  }

  /** Back from a panel to the game. Must be called from a user gesture
   * (a key press or click) so the browser will re-grant pointer lock. */
  closeUi(): void {
    if (!this.uiOpen) return;
    this.uiOpen = false;
    this.inputEnabled = true;
    if (this.controlMode !== "pointer") return;
    const fallBack = (): void => {
      if (document.pointerLockElement !== this.domElement) this.controlMode = "drag";
    };
    try {
      const result: unknown = this.domElement.requestPointerLock();
      if (result instanceof Promise) result.catch(fallBack);
    } catch {
      fallBack();
    }
    setTimeout(fallBack, POINTER_LOCK_WATCHDOG_MS);
  }

  get isUiOpen(): boolean {
    return this.uiOpen;
  }

  /** Leave play and show the menu (pause button on touch, Escape on desktop). */
  releaseControl(): void {
    this.uiOpen = false;
    this.inputEnabled = true;
    if (document.pointerLockElement === this.domElement) document.exitPointerLock();
    this.enterMode("idle");
  }

  private applyLook(movementX: number, movementY: number, sensitivity: number): void {
    const scale = sensitivity * this.options.sensitivity;
    this.yaw -= movementX * scale;
    this.pitch -= movementY * scale * (this.options.invertY ? -1 : 1);
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
  }

  /** Camera rotation from an external source (the touch controls' look
   * surface), in pixels of drag. */
  lookBy(pixelsX: number, pixelsY: number): void {
    if (this.controlMode === "idle") return;
    this.applyLook(pixelsX, pixelsY, DRAG_SENSITIVITY);
  }

  /** Movement from an external source (the touch controls' joystick),
   * merged with whatever the keyboard says every frame. */
  setExternalInput(input: ExternalInput | null): void {
    if (input && input.jump && !this.external?.jump) this.registerJumpTap();
    this.external = input;
  }

  private currentInput(): {
    forward: number;
    right: number;
    jump: boolean;
    sprint: boolean;
    descend: boolean;
  } {
    let forward = 0;
    let right = 0;
    let jump = false;
    let sprint = false;
    let descend = false;
    if (this.inputEnabled) {
      for (const code of this.pressed) {
        const action = KEY_BINDINGS[code];
        if (action === "forward") forward += 1;
        else if (action === "back") forward -= 1;
        else if (action === "right") right += 1;
        else if (action === "left") right -= 1;
        else if (action === "jump") jump = true;
        else if (action === "sprint") sprint = true;
        else if (action === "descend") descend = true;
      }
      if (this.external) {
        forward += this.external.forward;
        right += this.external.right;
        jump = jump || this.external.jump;
        sprint = sprint || this.external.sprint;
        descend = descend || this.external.descend === true;
      }
    }
    return {
      forward: Math.max(-1, Math.min(1, forward)),
      right: Math.max(-1, Math.min(1, right)),
      jump,
      sprint,
      descend,
    };
  }

  /** A one-block ledge straight ahead, with headroom to hop onto it. */
  private shouldAutoJump(forward: number, right: number): boolean {
    if (!this.options.autoJump || !this.state.onGround) return false;
    const magnitude = Math.hypot(forward, right);
    if (magnitude < 0.5) return false;
    const f = forwardVector(this.yaw);
    const r = rightVector(this.yaw);
    const dx = (f.x * forward + r.x * right) / magnitude;
    const dz = (f.z * forward + r.z * right) / magnitude;
    const p = this.state.position;
    const ax = Math.floor(p.x + dx * 0.62);
    const az = Math.floor(p.z + dz * 0.62);
    const y = Math.floor(p.y + 0.01);
    if (ax === Math.floor(p.x) && az === Math.floor(p.z)) return false;
    return (
      this.solidAt(ax, y, az) &&
      !this.solidAt(ax, y + 1, az) &&
      !this.solidAt(ax, y + 2, az) &&
      !this.solidAt(Math.floor(p.x), y + 2, Math.floor(p.z))
    );
  }

  private tick(input: ReturnType<PlayerController["currentInput"]>): void {
    // Ease the stick toward its target: acceleration without touching the
    // physics core's "velocity is what the input says" contract.
    const ease = (current: number, target: number): number => {
      const rate = Math.abs(target) > Math.abs(current) ? INPUT_ATTACK : INPUT_RELEASE;
      return current + (target - current) * (1 - Math.exp(-TICK * rate));
    };
    this.smoothForward = ease(this.smoothForward, input.forward);
    this.smoothRight = ease(this.smoothRight, input.right);
    if (Math.abs(this.smoothForward) < 0.002) this.smoothForward = 0;
    if (Math.abs(this.smoothRight) < 0.002) this.smoothRight = 0;

    const before = this.state.position;
    this.previous = before;

    if (this.flying) {
      this.state = stepFlight(
        this.state,
        {
          forward: this.smoothForward,
          right: this.smoothRight,
          up: (input.jump ? 1 : 0) - (input.descend ? 1 : 0),
          yaw: this.yaw,
          sprint: input.sprint,
        },
        TICK,
        this.solidAt,
      );
      // Touching down while descending lands the player.
      if (this.state.onGround && input.descend) {
        this.flying = false;
        this.onFlightChange?.(false);
      }
      this.wasOnGround = this.state.onGround;
      return;
    }

    const jump = input.jump || this.shouldAutoJump(input.forward, input.right);
    const vyBefore = this.state.velocity.y;
    this.state = stepPhysics(
      this.state,
      {
        forward: this.smoothForward,
        right: this.smoothRight,
        jump,
        sprint: input.sprint,
        yaw: this.yaw,
      },
      TICK,
      this.solidAt,
      this.waterAt,
    );

    const inWater = waterRegime(this.state.position, this.waterAt) !== "none";
    if (inWater !== this.wasInWater) {
      this.events.onSplash?.(inWater);
      this.wasInWater = inWater;
    }

    if (!this.state.onGround) this.fallSpeed = Math.max(this.fallSpeed, -vyBefore);
    if (this.state.onGround && !this.wasOnGround) {
      if (this.fallSpeed > 5 && !inWater) {
        this.landDip = Math.min(0.28, this.fallSpeed * 0.014);
        this.events.onLand?.(this.fallSpeed, this.blockBelow());
      }
      this.fallSpeed = 0;
    }
    if (!this.state.onGround && this.wasOnGround && this.state.velocity.y > 4 && !inWater) {
      this.events.onJump?.();
    }
    this.wasOnGround = this.state.onGround;

    const travelled = Math.hypot(
      this.state.position.x - before.x,
      this.state.position.z - before.z,
    );
    if (this.state.onGround && !inWater) {
      this.stepTravel += travelled;
      if (this.stepTravel >= STEP_DISTANCE) {
        this.stepTravel = 0;
        this.events.onStep?.(this.blockBelow());
      }
    }
  }

  private blockBelow(): BlockId {
    const p = this.state.position;
    return this.world.getBlock(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }

  private syncCamera(alpha: number): void {
    const p = this.state.position;
    const q = this.previous;
    const bobY = Math.sin(this.bobPhase * 2) * 0.05 * this.bobAmount;
    const bobX = Math.cos(this.bobPhase) * 0.035 * this.bobAmount;
    const r = rightVector(this.yaw);
    this.camera.position.set(
      lerp(q.x, p.x, alpha) + r.x * bobX,
      lerp(q.y, p.y, alpha) + PLAYER_EYE_HEIGHT + bobY - this.landDip,
      lerp(q.z, p.z, alpha) + r.z * bobX,
    );
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.z = -bobX * 0.35;
  }

  update(dt: number): void {
    let alpha = 1;
    if (this.controlMode !== "idle") {
      const input = this.currentInput();
      this.accumulator += dt;
      let ticks = 0;
      while (this.accumulator >= TICK && ticks < MAX_TICKS_PER_FRAME) {
        this.tick(input);
        this.accumulator -= TICK;
        ticks++;
      }
      if (ticks === MAX_TICKS_PER_FRAME) this.accumulator = 0; // long hitch: don't spiral
      alpha = this.accumulator / TICK;

      // View bob follows actual ground speed, and fades in the air.
      const v = this.state.velocity;
      const speed = Math.hypot(v.x, v.z);
      const walking = this.state.onGround && !this.flying && speed > 0.5;
      const targetBob = walking && this.options.viewBob ? Math.min(1, speed / MOVE_SPEED) : 0;
      this.bobAmount += (targetBob - this.bobAmount) * (1 - Math.exp(-dt * 10));
      if (walking) this.bobPhase += dt * speed * 1.55;
      this.landDip *= Math.exp(-dt * 9);

      // Speed widens the view a touch.
      const fast = input.sprint && (Math.abs(input.forward) > 0.1 || Math.abs(input.right) > 0.1);
      const targetKick = fast ? (this.flying ? 12 : 7) : 0;
      this.fovKick += (targetKick - this.fovKick) * (1 - Math.exp(-dt * 7));
      const fov = this.options.fov + this.fovKick;
      if (Math.abs(this.camera.fov - fov) > 0.02) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
      this.jumpWasDown = input.jump;
    }
    this.syncCamera(alpha);
  }

  /** The current view-bob offset, so things attached to the view (the
   * held block) can sway with the player's step. */
  get bob(): { x: number; y: number } {
    return {
      x: Math.cos(this.bobPhase) * 0.035 * this.bobAmount,
      y: Math.sin(this.bobPhase * 2) * 0.05 * this.bobAmount - this.landDip,
    };
  }

  /** Whether the camera itself is under water (drives the underwater look). */
  get eyeInWater(): boolean {
    const c = this.camera.position;
    return this.waterAt(Math.floor(c.x), Math.floor(c.y + 0.1), Math.floor(c.z));
  }

  get mode(): ControlMode {
    return this.controlMode;
  }

  get isActive(): boolean {
    return this.controlMode !== "idle";
  }

  get isLocked(): boolean {
    return this.controlMode === "pointer";
  }

  get isFlying(): boolean {
    return this.flying;
  }

  get position(): PlayerPhysicsState["position"] {
    return this.state.position;
  }

  get velocity(): PlayerPhysicsState["velocity"] {
    return this.state.velocity;
  }

  get onGround(): boolean {
    return this.state.onGround;
  }

  get eyeYaw(): number {
    return this.yaw;
  }

  get eyePitch(): number {
    return this.pitch;
  }

  get jumpHeld(): boolean {
    return this.jumpWasDown;
  }

  pose(): SavedPose {
    const p = this.state.position;
    return { x: p.x, y: p.y, z: p.z, yaw: this.yaw, pitch: this.pitch, flying: this.flying };
  }

  /** Puts the player back where a previous session left them. */
  restore(pose: SavedPose): void {
    this.state = {
      position: { x: pose.x, y: pose.y, z: pose.z },
      velocity: { x: 0, y: 0, z: 0 },
      onGround: false,
    };
    this.previous = this.state.position;
    this.yaw = pose.yaw;
    this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pose.pitch));
    this.flying = pose.flying;
    this.syncCamera(1);
  }
}
