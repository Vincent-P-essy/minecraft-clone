import { describe, expect, it } from "vitest";
import { joystickVector } from "./touch-controls";

const R = 56;

describe("joystickVector", () => {
  it("is neutral inside the dead zone", () => {
    expect(joystickVector(0, 0, R)).toEqual({ forward: 0, right: 0, sprint: false });
    expect(joystickVector(4, 4, R)).toEqual({ forward: 0, right: 0, sprint: false });
  });

  it("pushing up drives forward, pushing down drives backward", () => {
    const up = joystickVector(0, -R, R);
    expect(up.forward).toBeCloseTo(1);
    expect(up.right).toBeCloseTo(0);
    const down = joystickVector(0, R, R);
    expect(down.forward).toBeCloseTo(-1);
  });

  it("pushing right strafes right, pushing left strafes left", () => {
    expect(joystickVector(R, 0, R).right).toBeCloseTo(1);
    expect(joystickVector(-R, 0, R).right).toBeCloseTo(-1);
  });

  it("clamps magnitude to 1 beyond the ring, preserving direction", () => {
    const v = joystickVector(R * 3, 0, R); // way past the edge, straight right
    expect(v.right).toBeCloseTo(1);
    expect(v.forward).toBeCloseTo(0);
    expect(Math.hypot(v.forward, v.right)).toBeLessThanOrEqual(1.0001);
  });

  it("keeps diagonal magnitude within the unit circle", () => {
    const v = joystickVector(R, -R, R); // full up-right
    expect(Math.hypot(v.forward, v.right)).toBeCloseTo(1, 5);
    expect(v.forward).toBeGreaterThan(0);
    expect(v.right).toBeGreaterThan(0);
  });

  it("flags sprint only when pushed near the edge", () => {
    expect(joystickVector(0, -R * 0.5, R).sprint).toBe(false);
    expect(joystickVector(0, -R, R).sprint).toBe(true);
  });

  it("scales a half push to about half speed", () => {
    const v = joystickVector(0, -R * 0.5, R);
    expect(v.forward).toBeCloseTo(0.5, 5);
  });
});
