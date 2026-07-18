/** Pure player movement and collision math — no Three.js, no DOM, no World.
 * Callers hand in a SolidQuery closure over whatever block source they like,
 * which is what makes this independently testable against synthetic terrain. */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface AABB {
  readonly min: Vec3;
  readonly max: Vec3;
}

export type SolidQuery = (x: number, y: number, z: number) => boolean;

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE_HEIGHT = 1.62;

export const GRAVITY = 28;
export const JUMP_SPEED = 9;
export const TERMINAL_VELOCITY = -40;
export const MOVE_SPEED = 5.2;
export const SPRINT_MULTIPLIER = 1.6;

const COLLISION_EPSILON = 1e-4;
const BISECTION_ITERATIONS = 16;

/** The player's bounding box for a given feet position (bottom-center). */
export function aabbFromFeetPosition(pos: Vec3): AABB {
  const half = PLAYER_WIDTH / 2;
  return {
    min: { x: pos.x - half, y: pos.y, z: pos.z - half },
    max: { x: pos.x + half, y: pos.y + PLAYER_HEIGHT, z: pos.z + half },
  };
}

export function aabbIntersectsSolid(aabb: AABB, isSolid: SolidQuery): boolean {
  const minX = Math.floor(aabb.min.x);
  const maxX = Math.floor(aabb.max.x - COLLISION_EPSILON);
  const minY = Math.floor(aabb.min.y);
  const maxY = Math.floor(aabb.max.y - COLLISION_EPSILON);
  const minZ = Math.floor(aabb.min.z);
  const maxZ = Math.floor(aabb.max.z - COLLISION_EPSILON);

  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        if (isSolid(x, y, z)) return true;
      }
    }
  }
  return false;
}

/** Forward direction for a yaw angle, matching Three.js's rotation.y
 * convention exactly (camera looks down -Z at yaw 0). */
export function forwardVector(yaw: number): Vec3 {
  return { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
}

/** Right-strafe direction for a yaw angle — perpendicular to forwardVector,
 * also matching Three.js's local +X axis after the same yaw rotation. */
export function rightVector(yaw: number): Vec3 {
  return { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
}

/** Moves `base[axis]` by up to `delta`, binary-searching down to the
 * largest sub-step that doesn't collide. Assumes `base` itself is already
 * non-colliding and `delta` is small relative to a block (true for any
 * reasonable per-frame movement), so the collision boundary is unique. */
function resolveAxis(
  base: Vec3,
  axis: "x" | "y" | "z",
  delta: number,
  isSolid: SolidQuery,
): number {
  if (delta === 0) return base[axis];

  const at = (d: number): boolean =>
    aabbIntersectsSolid(aabbFromFeetPosition({ ...base, [axis]: base[axis] + d }), isSolid);

  if (!at(delta)) return base[axis] + delta;

  let lo = 0;
  let hi = delta;
  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return base[axis] + lo;
}

export interface MoveResult {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly onGround: boolean;
}

/** Displaces the player by (dx, dy, dz), resolving one axis at a time so a
 * diagonal move into a corner slides along the wall instead of tunneling
 * through it or getting stuck. */
export function moveAndCollide(
  position: Vec3,
  velocity: Vec3,
  dx: number,
  dy: number,
  dz: number,
  isSolid: SolidQuery,
): MoveResult {
  let cur: Vec3 = position;
  let vx = velocity.x;
  let vy = velocity.y;
  let vz = velocity.z;
  let onGround = false;

  const nx = resolveAxis(cur, "x", dx, isSolid);
  if (Math.abs(nx - (cur.x + dx)) > COLLISION_EPSILON) vx = 0;
  cur = { ...cur, x: nx };

  const nz = resolveAxis(cur, "z", dz, isSolid);
  if (Math.abs(nz - (cur.z + dz)) > COLLISION_EPSILON) vz = 0;
  cur = { ...cur, z: nz };

  const ny = resolveAxis(cur, "y", dy, isSolid);
  if (Math.abs(ny - (cur.y + dy)) > COLLISION_EPSILON) {
    vy = 0;
    if (dy < 0) onGround = true;
  }
  cur = { ...cur, y: ny };

  return { position: cur, velocity: { x: vx, y: vy, z: vz }, onGround };
}

export interface PlayerPhysicsState {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly onGround: boolean;
}

export interface MoveInput {
  /** -1..1, positive = forward (W) */
  readonly forward: number;
  /** -1..1, positive = strafe right (D) */
  readonly right: number;
  readonly jump: boolean;
  /** Camera yaw in radians, Three.js rotation.y convention. */
  readonly yaw: number;
  readonly sprint?: boolean;
}

/** Advances the player's physics state by one frame: gravity, jump, input-
 * driven horizontal movement, and collision resolution against `isSolid`. */
export function stepPhysics(
  state: PlayerPhysicsState,
  input: MoveInput,
  dt: number,
  isSolid: SolidQuery,
): PlayerPhysicsState {
  const fwd = forwardVector(input.yaw);
  const right = rightVector(input.yaw);

  let ix = fwd.x * input.forward + right.x * input.right;
  let iz = fwd.z * input.forward + right.z * input.right;
  const inputLength = Math.hypot(ix, iz);
  if (inputLength > 1) {
    ix /= inputLength;
    iz /= inputLength;
  }

  let vy = state.velocity.y - GRAVITY * dt;
  vy = Math.max(vy, TERMINAL_VELOCITY);
  if (input.jump && state.onGround) {
    vy = JUMP_SPEED;
  }

  const speed = MOVE_SPEED * (input.sprint ? SPRINT_MULTIPLIER : 1);
  const vx = ix * speed;
  const vz = iz * speed;

  const result = moveAndCollide(
    state.position,
    { x: vx, y: vy, z: vz },
    vx * dt,
    vy * dt,
    vz * dt,
    isSolid,
  );

  return result;
}

/** Highest non-solid Y at (x, z), scanning down from `fromY`, for spawning
 * or teleporting somewhere that won't immediately collide. */
export function findGroundHeight(x: number, z: number, fromY: number, isSolid: SolidQuery): number {
  for (let y = fromY; y > 0; y--) {
    if (isSolid(x, y, z) && !isSolid(x, y + 1, z)) {
      return y + 1;
    }
  }
  return fromY;
}
