import { describe, expect, it } from "vitest";
import {
  aabbFromFeetPosition,
  aabbIntersectsSolid,
  findGroundHeight,
  forwardVector,
  GRAVITY,
  JUMP_SPEED,
  MOVE_SPEED,
  moveAndCollide,
  type PlayerPhysicsState,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  rightVector,
  type SolidQuery,
  SPRINT_MULTIPLIER,
  stepPhysics,
  TERMINAL_VELOCITY,
} from "./physics";

/** Solid everywhere at or below `groundY`, air above — an infinite flat floor. */
function flatGround(groundY: number): SolidQuery {
  return (_x, y, _z) => y <= groundY;
}

describe("aabbFromFeetPosition", () => {
  it("is centered on x/z and sits on top of the feet position", () => {
    const aabb = aabbFromFeetPosition({ x: 10, y: 5, z: -3 });
    expect(aabb.min).toEqual({ x: 10 - PLAYER_WIDTH / 2, y: 5, z: -3 - PLAYER_WIDTH / 2 });
    expect(aabb.max).toEqual({
      x: 10 + PLAYER_WIDTH / 2,
      y: 5 + PLAYER_HEIGHT,
      z: -3 + PLAYER_WIDTH / 2,
    });
  });
});

describe("aabbIntersectsSolid", () => {
  it("is false when nothing is solid", () => {
    const aabb = aabbFromFeetPosition({ x: 0, y: 10, z: 0 });
    expect(aabbIntersectsSolid(aabb, () => false)).toBe(false);
  });

  it("is true when a block inside the box is solid", () => {
    const aabb = aabbFromFeetPosition({ x: 0, y: 10, z: 0 });
    expect(aabbIntersectsSolid(aabb, (x, y, z) => x === 0 && y === 10 && z === 0)).toBe(true);
  });

  it("is false for a solid block clearly outside the box", () => {
    const aabb = aabbFromFeetPosition({ x: 0, y: 10, z: 0 });
    expect(aabbIntersectsSolid(aabb, (x, y, z) => x === 50 && y === 50 && z === 50)).toBe(false);
  });

  it("standing exactly on an integer-Y floor doesn't count as intersecting it", () => {
    // Feet at y=5 means the AABB's min.y is exactly 5 — the floor block
    // occupying [4,5) must not register as overlapping.
    const aabb = aabbFromFeetPosition({ x: 0, y: 5, z: 0 });
    expect(aabbIntersectsSolid(aabb, flatGround(4))).toBe(false);
  });

  it("sinking one unit below the floor does intersect it", () => {
    const aabb = aabbFromFeetPosition({ x: 0, y: 4, z: 0 });
    expect(aabbIntersectsSolid(aabb, flatGround(4))).toBe(true);
  });
});

describe("forwardVector / rightVector", () => {
  it("faces -Z at yaw 0, matching Three.js's default camera facing", () => {
    const f = forwardVector(0);
    expect(f.x).toBeCloseTo(0);
    expect(f.z).toBeCloseTo(-1);
  });

  it("right-strafe is +X at yaw 0", () => {
    const r = rightVector(0);
    expect(r.x).toBeCloseTo(1);
    expect(r.z).toBeCloseTo(0);
  });

  it("rotates consistently with Three.js's rotation.y convention at a quarter turn", () => {
    const f = forwardVector(Math.PI / 2);
    expect(f.x).toBeCloseTo(-1);
    expect(f.z).toBeCloseTo(0);
  });

  it("forward and right stay perpendicular and unit-length at any yaw", () => {
    for (let yaw = -10; yaw <= 10; yaw += 0.37) {
      const f = forwardVector(yaw);
      const r = rightVector(yaw);
      expect(Math.hypot(f.x, f.z)).toBeCloseTo(1);
      expect(Math.hypot(r.x, r.z)).toBeCloseTo(1);
      expect(f.x * r.x + f.z * r.z).toBeCloseTo(0);
    }
  });
});

describe("moveAndCollide in open air", () => {
  it("moves by exactly the requested delta with no obstacles", () => {
    const result = moveAndCollide(
      { x: 0, y: 20, z: 0 },
      { x: 1, y: 0, z: 2 },
      0.1,
      0,
      0.2,
      () => false,
    );
    expect(result.position).toEqual({ x: 0.1, y: 20, z: 0.2 });
    expect(result.velocity).toEqual({ x: 1, y: 0, z: 2 });
    expect(result.onGround).toBe(false);
  });
});

describe("moveAndCollide against a wall", () => {
  it("stops the X axis at the wall but still allows Z movement (sliding)", () => {
    // A solid wall at x=5 (occupying [5,6)); approaching from x=4.5.
    const isSolid: SolidQuery = (x) => x === 5;
    const result = moveAndCollide(
      { x: 4.5 - PLAYER_WIDTH / 2, y: 20, z: 0 },
      { x: 3, y: 0, z: 1 },
      1, // would reach x=5.5+, well past the wall
      0,
      0.3,
      isSolid,
    );
    // Clamped so the AABB's max.x never meaningfully passes the wall's min x
    // (5) — collision detection has its own small epsilon buffer, so allow
    // a matching tolerance rather than demanding exact geometric contact.
    expect(result.position.x + PLAYER_WIDTH / 2).toBeLessThanOrEqual(5 + 1e-3);
    expect(result.velocity.x).toBe(0);
    // Z movement is unrelated to the wall and should proceed freely.
    expect(result.position.z).toBeCloseTo(0.3);
    expect(result.velocity.z).toBe(1);
  });
});

describe("moveAndCollide falling onto ground", () => {
  it("lands exactly on top of the floor, zeroes vertical velocity, and reports onGround", () => {
    // Floor is solid up to y=4 (occupies [4,5)), so resting height is y=5.
    // A small per-step delta, consistent with moveAndCollide's documented
    // assumption — this isn't a continuous sweep, so a delta anywhere near
    // the gap size could tunnel through a thin obstacle in one step.
    const result = moveAndCollide(
      { x: 0, y: 5.1, z: 0 },
      { x: 0, y: -10, z: 0 },
      0,
      -0.3, // would fall to y=4.8, through the floor's top at y=5
      0,
      flatGround(4),
    );
    expect(result.position.y).toBeCloseTo(5, 4);
    expect(result.velocity.y).toBe(0);
    expect(result.onGround).toBe(true);
  });

  it("does not report onGround when blocked while moving upward (hitting a ceiling)", () => {
    const isSolid: SolidQuery = (_x, y) => y === 10;
    // Start just below the ceiling (feet at 8, head reaches 9.8) and take a
    // small step up, so the step actually crosses the boundary at y=10-1.8=8.2
    // instead of jumping clean over the 1-block-thick ceiling.
    const result = moveAndCollide({ x: 0, y: 8.1, z: 0 }, { x: 0, y: 5, z: 0 }, 0, 0.3, 0, isSolid);
    expect(result.velocity.y).toBe(0);
    expect(result.onGround).toBe(false);
  });
});

describe("stepPhysics", () => {
  const state = (overrides: Partial<PlayerPhysicsState> = {}): PlayerPhysicsState => ({
    position: { x: 0, y: 10, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    onGround: false,
    ...overrides,
  });

  it("accumulates downward velocity from gravity while airborne", () => {
    const next = stepPhysics(
      state(),
      { forward: 0, right: 0, jump: false, yaw: 0 },
      1 / 60,
      () => false,
    );
    expect(next.velocity.y).toBeCloseTo(-GRAVITY / 60);
  });

  it("never exceeds terminal velocity", () => {
    let s = state({ velocity: { x: 0, y: -1000, z: 0 } });
    s = stepPhysics(s, { forward: 0, right: 0, jump: false, yaw: 0 }, 1, () => false);
    expect(s.velocity.y).toBeGreaterThanOrEqual(TERMINAL_VELOCITY);
  });

  it("jumps only when already on the ground", () => {
    const grounded = state({ onGround: true });
    const jumped = stepPhysics(
      grounded,
      { forward: 0, right: 0, jump: true, yaw: 0 },
      1 / 60,
      flatGround(9),
    );
    // A jump is an impulse: it sets vy outright rather than adding on top
    // of the frame's own tiny gravity decrement.
    expect(jumped.velocity.y).toBeCloseTo(JUMP_SPEED);

    const airborne = state({ onGround: false });
    const stillFalling = stepPhysics(
      airborne,
      { forward: 0, right: 0, jump: true, yaw: 0 },
      1 / 60,
      () => false,
    );
    expect(stillFalling.velocity.y).toBeLessThan(0);
  });

  it("normalizes diagonal input so forward+strafe isn't faster than forward alone", () => {
    const straight = stepPhysics(
      state(),
      { forward: 1, right: 0, jump: false, yaw: 0 },
      1 / 60,
      () => false,
    );
    const diagonal = stepPhysics(
      state(),
      { forward: 1, right: 1, jump: false, yaw: 0 },
      1 / 60,
      () => false,
    );

    const straightSpeed = Math.hypot(
      straight.position.x - state().position.x,
      straight.position.z - state().position.z,
    );
    const diagonalSpeed = Math.hypot(
      diagonal.position.x - state().position.x,
      diagonal.position.z - state().position.z,
    );
    expect(diagonalSpeed).toBeCloseTo(straightSpeed, 5);
  });

  it("moves forward at MOVE_SPEED blocks per second", () => {
    const dt = 1 / 60;
    const next = stepPhysics(
      state(),
      { forward: 1, right: 0, jump: false, yaw: 0 },
      dt,
      () => false,
    );
    expect(next.position.z).toBeCloseTo(-MOVE_SPEED * dt);
  });

  it("sprinting multiplies horizontal speed without touching vertical physics", () => {
    const dt = 1 / 60;
    const walking = stepPhysics(
      state(),
      { forward: 1, right: 0, jump: false, yaw: 0 },
      dt,
      () => false,
    );
    const sprinting = stepPhysics(
      state(),
      { forward: 1, right: 0, jump: false, yaw: 0, sprint: true },
      dt,
      () => false,
    );
    expect(sprinting.position.z).toBeCloseTo(walking.position.z * SPRINT_MULTIPLIER, 5);
    expect(sprinting.velocity.y).toBeCloseTo(walking.velocity.y, 10);
  });

  it("standing still on flat ground stays exactly on the surface, frame after frame", () => {
    let s = state({ position: { x: 0, y: 5, z: 0 }, onGround: true });
    const ground = flatGround(4);
    for (let i = 0; i < 30; i++) {
      s = stepPhysics(s, { forward: 0, right: 0, jump: false, yaw: 0 }, 1 / 60, ground);
    }
    expect(s.position.y).toBeCloseTo(5, 4);
    expect(s.onGround).toBe(true);
  });
});

describe("findGroundHeight", () => {
  it("finds the first open space above a floor", () => {
    expect(findGroundHeight(0, 0, 50, flatGround(20))).toBe(21);
  });

  it("returns the scan start when nothing solid is found", () => {
    expect(findGroundHeight(0, 0, 50, () => false)).toBe(50);
  });
});
