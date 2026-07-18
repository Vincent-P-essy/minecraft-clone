import * as THREE from "three";
import { BLOCKS, BlockId, isSolid } from "../world/blocks";
import { affectedChunkCoords } from "../world/coords";
import type { World } from "../world/world";
import type { Hotbar } from "../ui/hotbar";
import { aabbFromFeetPosition, aabbIntersectsSolid, type Vec3 } from "./physics";
import type { PlayerController } from "./controller";
import { raycastVoxels } from "./raycast";

const REACH = 6;
/** Hold-to-repeat cadence for breaking/placing while the button stays down. */
const REPEAT_MS = 260;

/** The one thing interaction needs from the render side: "this chunk's
 * visuals are stale". The WebGL mesh manager implements it; the CPU
 * raycaster needs nothing (it reads blocks directly every frame). */
export interface ChunkVisualUpdater {
  updateChunk(cx: number, cz: number): void;
}
/** A press this short and still counts as a tap (drag-look mode: left-drag
 * looks around, a left tap breaks). */
const TAP_MS = 300;
const TAP_MAX_MOVE = 6;

/** Left click breaks the targeted block, right click places the hotbar's
 * selected block against the targeted face. Both are a raycast (reused
 * every frame for the highlight, see main.ts) plus a World edit plus a
 * remesh of every chunk the edit could visually affect. In pointer-lock
 * mode holding a button repeats the action; in drag-look mode the left
 * button doubles as the look control, so breaking is a quick tap. */
export class BlockInteraction {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: World;
  private readonly chunkMeshes: ChunkVisualUpdater;
  private readonly hotbar: Hotbar;
  private readonly controller: PlayerController;
  private repeatTimer: ReturnType<typeof setInterval> | undefined;
  private tapStart: { time: number; x: number; y: number } | undefined;
  /** Fired after every successful world edit — persistence hooks in here. */
  onEdit: ((worldX: number, worldY: number, worldZ: number, id: BlockId) => void) | undefined;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    world: World,
    chunkMeshes: ChunkVisualUpdater,
    hotbar: Hotbar,
    controller: PlayerController,
  ) {
    this.camera = camera;
    this.world = world;
    this.chunkMeshes = chunkMeshes;
    this.hotbar = hotbar;
    this.controller = controller;

    domElement.addEventListener("mousedown", (e) => {
      if (!this.controller.isActive) return;

      if (this.controller.isLocked) {
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
      if (!this.controller.isActive || this.controller.isLocked) return;
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

  raycastFromCamera(maxDistance = REACH) {
    const origin: Vec3 = {
      x: this.camera.position.x,
      y: this.camera.position.y,
      z: this.camera.position.z,
    };
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return raycastVoxels(origin, { x: dir.x, y: dir.y, z: dir.z }, maxDistance, (x, y, z) =>
      isSolid(this.world.getBlock(x, y, z)),
    );
  }

  private breakTargetedBlock(): void {
    const hit = this.raycastFromCamera();
    if (!hit) return;
    const current = this.world.getBlock(hit.blockX, hit.blockY, hit.blockZ);
    if (!BLOCKS[current].breakable) return;

    this.world.setBlock(hit.blockX, hit.blockY, hit.blockZ, BlockId.AIR);
    this.onEdit?.(hit.blockX, hit.blockY, hit.blockZ, BlockId.AIR);
    this.remesh(hit.blockX, hit.blockZ);
  }

  private placeTargetedBlock(): void {
    const hit = this.raycastFromCamera();
    if (!hit) return;
    if (this.world.getBlock(hit.placeX, hit.placeY, hit.placeZ) !== BlockId.AIR) return;
    if (this.overlapsPlayer(hit.placeX, hit.placeY, hit.placeZ)) return;

    this.world.setBlock(hit.placeX, hit.placeY, hit.placeZ, this.hotbar.selectedBlock);
    this.onEdit?.(hit.placeX, hit.placeY, hit.placeZ, this.hotbar.selectedBlock);
    this.remesh(hit.placeX, hit.placeZ);
  }

  private overlapsPlayer(x: number, y: number, z: number): boolean {
    const aabb = aabbFromFeetPosition(this.controller.position);
    return aabbIntersectsSolid(aabb, (bx, by, bz) => bx === x && by === y && bz === z);
  }

  private remesh(worldX: number, worldZ: number): void {
    for (const { cx, cz } of affectedChunkCoords(worldX, worldZ)) {
      this.chunkMeshes.updateChunk(cx, cz);
    }
  }
}
