import * as THREE from "three";
import { BLOCKS, BlockId, isPlant, isSolid, isTargetable } from "../world/blocks";
import { CHUNK_HEIGHT } from "../world/coords";
import type { World } from "../world/world";
import { aabbFromFeetPosition, aabbIntersectsSolid, type Vec3 } from "./physics";
import type { PlayerController } from "./controller";
import { type RaycastHit, raycastVoxels } from "./raycast";

const REACH = 6;
/** Hold-to-repeat cadence for breaking/placing while the button stays down. */
const REPEAT_MS = 230;

/** The one thing interaction needs from the render side: "this block
 * changed". The WebGL mesh manager re-lights and re-meshes around it; the
 * CPU raycaster needs nothing (it reads blocks directly every frame). */
export interface ChunkVisualUpdater {
  blockChanged(worldX: number, worldY: number, worldZ: number, id: BlockId): void;
}

/** Whatever supplies the block to place (the hotbar). */
export interface BlockSelection {
  readonly selectedBlock: BlockId;
}

/** A press this short and still counts as a tap (drag-look mode: left-drag
 * looks around, a left tap breaks). */
const TAP_MS = 300;
const TAP_MAX_MOVE = 6;

export interface EditEvent {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly id: BlockId;
  readonly previous: BlockId;
}

/** Left click breaks the targeted block, right click places the hotbar's
 * selected block against the targeted face. Both are a raycast (reused
 * every frame for the highlight, see main.ts) plus a World edit plus a
 * notification to the renderer. In pointer-lock mode holding a button
 * repeats the action; in drag-look mode the left button doubles as the
 * look control, so breaking is a quick tap. */
export class BlockInteraction {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: World;
  private readonly visuals: ChunkVisualUpdater;
  private readonly selection: BlockSelection;
  private readonly controller: PlayerController;
  private repeatTimer: ReturnType<typeof setInterval> | undefined;
  private tapStart: { time: number; x: number; y: number } | undefined;
  private readonly direction = new THREE.Vector3();
  /** Fired after every successful world edit — persistence, sound and
   * particles hook in here. */
  onEdit: ((edit: EditEvent) => void) | undefined;
  /** Set false while a menu is open so clicks don't reach the world. */
  enabled = true;
  /** Adventure mode: how long a block takes to dig (seconds). When unset,
   * or when it returns 0, blocks break at once. */
  digSeconds: ((block: BlockId) => number) | undefined;
  /** Adventure mode: whether the player actually has this block to place. */
  canPlace: ((block: BlockId) => boolean) | undefined;
  /** Fired a few times a second while digging, for the tapping sound. */
  onDigTick: ((block: BlockId) => void) | undefined;

  /** The block being dug, how far along it is, and whether the dig keeps
   * going by itself (a tap or a trigger pull) or only while a button is
   * held (the mouse). */
  private dig: {
    x: number;
    y: number;
    z: number;
    block: BlockId;
    elapsed: number;
    needed: number;
    auto: boolean;
    tick: number;
  } | null = null;
  private holding = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    world: World,
    visuals: ChunkVisualUpdater,
    selection: BlockSelection,
    controller: PlayerController,
  ) {
    this.camera = camera;
    this.world = world;
    this.visuals = visuals;
    this.selection = selection;
    this.controller = controller;

    domElement.addEventListener("mousedown", (e) => {
      if (!this.controller.isActive || !this.enabled) return;

      if (this.controller.isLocked) {
        if (e.button === 1) {
          this.pickTargetedBlock();
          e.preventDefault();
          return;
        }
        if (e.button === 0 && this.digSeconds) {
          // Timed digging: the button is held, update() does the rest.
          this.holding = true;
          this.beginDig(false);
          return;
        }
        const action =
          e.button === 0
            ? () => {
                this.breakTargetedBlock();
              }
            : e.button === 2
              ? () => {
                  this.placeTargetedBlock();
                }
              : undefined;
        if (!action) return;
        action();
        this.stopRepeat();
        this.repeatTimer = setInterval(action, REPEAT_MS);
        return;
      }

      // Drag-look mode: left press might be a look-drag or a break-tap —
      // decide on release. Right click places immediately.
      if (e.button === 0) {
        this.tapStart = { time: performance.now(), x: e.clientX, y: e.clientY };
      } else if (e.button === 2) {
        this.placeTargetedBlock();
      }
    });

    document.addEventListener("mouseup", (e) => {
      this.stopRepeat();
      if (e.button === 0) {
        this.holding = false;
        if (this.dig && !this.dig.auto) this.dig = null;
      }
      if (!this.controller.isActive || this.controller.isLocked || !this.enabled) return;
      if (e.button === 0 && this.tapStart) {
        const moved = Math.hypot(e.clientX - this.tapStart.x, e.clientY - this.tapStart.y);
        const elapsed = performance.now() - this.tapStart.time;
        if (moved <= TAP_MAX_MOVE && elapsed <= TAP_MS) this.breakTargetedBlock();
        this.tapStart = undefined;
      }
    });

    document.addEventListener("pointerlockchange", () => {
      this.stopRepeat();
    });
    window.addEventListener("blur", () => {
      this.stopRepeat();
    });
  }

  private stopRepeat(): void {
    if (this.repeatTimer !== undefined) {
      clearInterval(this.repeatTimer);
      this.repeatTimer = undefined;
    }
  }

  /** Starts digging whatever is under the crosshair. Returns false if
   * there's nothing there that can be dug. */
  private beginDig(auto: boolean): boolean {
    const hit = this.raycastFromCamera();
    if (!hit) return false;
    const block = this.world.getBlock(hit.blockX, hit.blockY, hit.blockZ);
    if (!BLOCKS[block].breakable) return false;
    const same =
      this.dig?.x === hit.blockX && this.dig.y === hit.blockY && this.dig.z === hit.blockZ;
    if (same && this.dig) {
      this.dig.auto = this.dig.auto || auto;
      return true;
    }
    const needed = this.digSeconds?.(block) ?? 0;
    if (!Number.isFinite(needed)) return false;
    this.dig = {
      x: hit.blockX,
      y: hit.blockY,
      z: hit.blockZ,
      block,
      elapsed: 0,
      needed,
      auto,
      tick: 0,
    };
    return true;
  }

  /** Advances a dig in progress. Call once a frame. */
  update(dt: number): void {
    const dig = this.dig;
    if (!dig) return;
    if (!this.enabled || !this.controller.isActive) {
      this.dig = null;
      return;
    }
    // Looking away abandons the block; with the button still down, the
    // next one under the crosshair is started straight away.
    const hit = this.raycastFromCamera();
    const onTarget =
      hit !== null && hit.blockX === dig.x && hit.blockY === dig.y && hit.blockZ === dig.z;
    if (!onTarget || this.world.getBlock(dig.x, dig.y, dig.z) !== dig.block) {
      this.dig = null;
      if (this.holding) this.beginDig(false);
      return;
    }
    dig.elapsed += dt;
    dig.tick -= dt;
    if (dig.tick <= 0) {
      dig.tick = 0.22;
      this.onDigTick?.(dig.block);
    }
    if (dig.elapsed < dig.needed) return;
    this.dig = null;
    this.breakAt(dig.x, dig.y, dig.z);
    if (this.holding) this.beginDig(false);
  }

  /** The dig in progress, for the overlay: which block, and 0..1 done. */
  get digProgress(): { x: number; y: number; z: number; fraction: number } | null {
    const dig = this.dig;
    if (!dig) return null;
    return {
      x: dig.x,
      y: dig.y,
      z: dig.z,
      fraction: dig.needed > 0 ? Math.min(1, dig.elapsed / dig.needed) : 1,
    };
  }

  raycastFromCamera(maxDistance = REACH): RaycastHit | null {
    const origin: Vec3 = {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
    };
    const dir = this.direction;
    this.camera.getWorldDirection(dir);
    return raycastVoxels(origin, { x: dir.x, y: dir.y, z: dir.z }, maxDistance, (x, y, z) =>
      isTargetable(this.world.getBlock(x, y, z)),
    );
  }

  private setBlock(x: number, y: number, z: number, id: BlockId): void {
    const previous = this.world.getBlock(x, y, z);
    this.world.setBlock(x, y, z, id);
    this.visuals.blockChanged(x, y, z, id);
    this.onEdit?.({ x, y, z, id, previous });
  }

  /** Break the block under the crosshair. Public: the touch controls and
   * the gamepad call this directly. With timed digging on, it starts (or
   * keeps up) a dig that finishes by itself; otherwise the block goes at
   * once. */
  breakTargetedBlock(): void {
    if (this.digSeconds) {
      this.beginDig(true);
      return;
    }
    const hit = this.raycastFromCamera();
    if (!hit) return;
    this.breakAt(hit.blockX, hit.blockY, hit.blockZ);
  }

  private breakAt(x: number, y: number, z: number): void {
    const current = this.world.getBlock(x, y, z);
    if (!BLOCKS[current].breakable) return;
    this.setBlock(x, y, z, BlockId.AIR);
    // A plant can't hang in the air once its ground is gone.
    if (y + 1 < CHUNK_HEIGHT) {
      const above = this.world.getBlock(x, y + 1, z);
      if (isPlant(above)) this.setBlock(x, y + 1, z, BlockId.AIR);
    }
  }

  /** Place the hotbar's block against the targeted face. Public for the
   * touch controls (place button). */
  placeTargetedBlock(): void {
    const hit = this.raycastFromCamera();
    if (!hit) return;
    const block = this.selection.selectedBlock;
    if (this.canPlace && !this.canPlace(block)) return;

    // Aiming at a tuft of grass replaces it rather than stacking beside it.
    const target = this.world.getBlock(hit.blockX, hit.blockY, hit.blockZ);
    const into = BLOCKS[target].replaceable
      ? { x: hit.blockX, y: hit.blockY, z: hit.blockZ }
      : { x: hit.placeX, y: hit.placeY, z: hit.placeZ };
    if (into.y < 1 || into.y >= CHUNK_HEIGHT) return;
    if (!BLOCKS[this.world.getBlock(into.x, into.y, into.z)].replaceable) return;
    if (isSolid(block) && this.overlapsPlayer(into.x, into.y, into.z)) return;
    // Plants need something to root in.
    if (isPlant(block) && !isSolid(this.world.getBlock(into.x, into.y - 1, into.z))) return;

    this.setBlock(into.x, into.y, into.z, block);
  }

  /** Middle click: which block is under the crosshair (for the hotbar). */
  pickTargetedBlock(): void {
    const hit = this.raycastFromCamera();
    if (!hit) return;
    this.onPick?.(this.world.getBlock(hit.blockX, hit.blockY, hit.blockZ));
  }

  onPick: ((id: BlockId) => void) | undefined;

  private overlapsPlayer(x: number, y: number, z: number): boolean {
    const aabb = aabbFromFeetPosition(this.controller.position);
    return aabbIntersectsSolid(aabb, (bx, by, bz) => bx === x && by === y && bz === z);
  }
}
