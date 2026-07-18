import type { Face } from "../render/atlas-layout";
import type { SolidQuery, Vec3 } from "./physics";

export interface RaycastHit {
  readonly blockX: number;
  readonly blockY: number;
  readonly blockZ: number;
  readonly face: Face;
  /** The empty voxel just outside the hit face — where a placed block goes. */
  readonly placeX: number;
  readonly placeY: number;
  readonly placeZ: number;
  readonly distance: number;
}

/** Amanatides-Woo voxel DDA: walks the ray one voxel boundary at a time (no
 * skipping thin obstacles the way fixed-step sampling can) and returns the
 * first solid block within maxDistance, or null. `direction` need not be
 * normalized. */
export function raycastVoxels(
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  isSolid: SolidQuery,
): RaycastHit | null {
  const len = Math.hypot(direction.x, direction.y, direction.z);
  if (len === 0) return null;
  const dx = direction.x / len;
  const dy = direction.y / len;
  const dz = direction.z / len;

  let voxelX = Math.floor(origin.x);
  let voxelY = Math.floor(origin.y);
  let voxelZ = Math.floor(origin.z);

  if (isSolid(voxelX, voxelY, voxelZ)) {
    // Degenerate: the ray starts inside solid geometry (shouldn't happen
    // during normal play since the camera never occupies a solid voxel).
    return {
      blockX: voxelX,
      blockY: voxelY,
      blockZ: voxelZ,
      face: "top",
      placeX: voxelX,
      placeY: voxelY + 1,
      placeZ: voxelZ,
      distance: 0,
    };
  }

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  let tMaxX = dx > 0 ? (voxelX + 1 - origin.x) / dx : dx < 0 ? (voxelX - origin.x) / dx : Infinity;
  let tMaxY = dy > 0 ? (voxelY + 1 - origin.y) / dy : dy < 0 ? (voxelY - origin.y) / dy : Infinity;
  let tMaxZ = dz > 0 ? (voxelZ + 1 - origin.z) / dz : dz < 0 ? (voxelZ - origin.z) / dz : Infinity;

  // Each iteration crosses exactly one voxel boundary, so this many steps
  // comfortably covers maxDistance even for a ray grazing along an axis.
  const maxSteps = Math.ceil(maxDistance) * 3 + 8;

  for (let i = 0; i < maxSteps; i++) {
    let axis: "x" | "y" | "z";
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) axis = "x";
    else if (tMaxY <= tMaxZ) axis = "y";
    else axis = "z";

    const t = axis === "x" ? tMaxX : axis === "y" ? tMaxY : tMaxZ;
    if (t > maxDistance) return null;

    const prevX = voxelX;
    const prevY = voxelY;
    const prevZ = voxelZ;
    let face: Face;

    if (axis === "x") {
      voxelX += stepX;
      tMaxX += tDeltaX;
      face = stepX > 0 ? "west" : "east";
    } else if (axis === "y") {
      voxelY += stepY;
      tMaxY += tDeltaY;
      face = stepY > 0 ? "bottom" : "top";
    } else {
      voxelZ += stepZ;
      tMaxZ += tDeltaZ;
      face = stepZ > 0 ? "north" : "south";
    }

    if (isSolid(voxelX, voxelY, voxelZ)) {
      return {
        blockX: voxelX,
        blockY: voxelY,
        blockZ: voxelZ,
        face,
        placeX: prevX,
        placeY: prevY,
        placeZ: prevZ,
        distance: t,
      };
    }
  }

  return null;
}
