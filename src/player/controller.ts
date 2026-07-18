import * as THREE from "three";
import { isSolid } from "../world/blocks";
import { CHUNK_HEIGHT } from "../world/coords";
import type { World } from "../world/world";
import {
  findGroundHeight,
  PLAYER_EYE_HEIGHT,
  type PlayerPhysicsState,
  stepPhysics,
} from "./physics";

const MOUSE_SENSITIVITY = 0.0022;
const MAX_PITCH = Math.PI / 2 - 0.01;

const KEY_BINDINGS: Record<string, "forward" | "back" | "left" | "right" | "jump" | "sprint"> = {
  KeyW: "forward",
  KeyS: "back",
  KeyA: "left",
  KeyD: "right",
  Space: "jump",
  ShiftLeft: "sprint",
  ShiftRight: "sprint",
};

/** Pointer-lock FPS movement: mouse look, WASD, gravity, and collision via
 * physics.ts. The overlay/play-button DOM dance and key tracking live here
 * because they're inherently browser glue; the actual physics is pure and
 * tested separately. */
export class PlayerController {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private readonly overlay: HTMLElement | null;
  private readonly world: World;

  private state: PlayerPhysicsState;
  private yaw = 0;
  private pitch = 0;
  private readonly pressed = new Set<string>();
  private locked = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    world: World,
    spawnX = 8,
    spawnZ = 8,
  ) {
    this.camera = camera;
    this.camera.rotation.order = "YXZ";
    this.domElement = domElement;
    this.overlay = document.querySelector("#overlay");
    this.world = world;

    const groundY = findGroundHeight(spawnX, spawnZ, CHUNK_HEIGHT - 1, (x, y, z) =>
      isSolid(this.world.getBlock(x, y, z)),
    );
    this.state = {
      position: { x: spawnX, y: groundY, z: spawnZ },
      velocity: { x: 0, y: 0, z: 0 },
      onGround: false,
    };

    this.bindEvents();
    this.syncCamera();
  }

  private bindEvents(): void {
    const playButton = document.querySelector<HTMLButtonElement>("#play-button");
    playButton?.addEventListener("click", () => {
      void this.domElement.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.domElement;
      this.overlay?.classList.toggle("hidden", this.locked);
      if (!this.locked) this.pressed.clear();
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.yaw -= e.movementX * MOUSE_SENSITIVITY;
      this.pitch -= e.movementY * MOUSE_SENSITIVITY;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    });

    document.addEventListener("keydown", (e) => {
      this.pressed.add(e.code);
    });
    document.addEventListener("keyup", (e) => {
      this.pressed.delete(e.code);
    });
    window.addEventListener("blur", () => {
      this.pressed.clear();
    });

    this.domElement.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });
  }

  private currentInput(): { forward: number; right: number; jump: boolean; sprint: boolean } {
    let forward = 0;
    let right = 0;
    let jump = false;
    let sprint = false;
    for (const code of this.pressed) {
      const action = KEY_BINDINGS[code];
      if (action === "forward") forward += 1;
      else if (action === "back") forward -= 1;
      else if (action === "right") right += 1;
      else if (action === "left") right -= 1;
      else if (action === "jump") jump = true;
      else if (action === "sprint") sprint = true;
    }
    return { forward, right, jump, sprint };
  }

  private syncCamera(): void {
    this.camera.position.set(
      this.state.position.x,
      this.state.position.y + PLAYER_EYE_HEIGHT,
      this.state.position.z,
    );
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.y = this.yaw;
  }

  update(dt: number): void {
    if (this.locked) {
      const { forward, right, jump, sprint } = this.currentInput();
      this.state = stepPhysics(
        this.state,
        { forward, right, jump, sprint, yaw: this.yaw },
        dt,
        (x, y, z) => isSolid(this.world.getBlock(x, y, z)),
      );
    }
    this.syncCamera();
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get position(): PlayerPhysicsState["position"] {
    return this.state.position;
  }

  get eyeYaw(): number {
    return this.yaw;
  }

  get eyePitch(): number {
    return this.pitch;
  }
}
