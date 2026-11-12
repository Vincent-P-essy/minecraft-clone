import { describe, expect, it } from "vitest";
import { applyDeadZone, GamepadInput, lookCurve, type PadSnapshot, stickVector } from "./gamepad";

function pad(
  axes: number[] = [0, 0, 0, 0],
  down: number[] = [],
  values: Record<number, number> = {},
): PadSnapshot {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: down.includes(i),
    value: values[i] ?? (down.includes(i) ? 1 : 0),
  }));
  return { axes, buttons };
}

describe("applyDeadZone", () => {
  it("is zero inside the zone and continuous at its edge", () => {
    expect(applyDeadZone(0.1)).toBe(0);
    expect(applyDeadZone(-0.18)).toBe(0);
    expect(applyDeadZone(0.181)).toBeLessThan(0.01);
  });

  it("reaches exactly ±1 at full deflection and keeps the sign", () => {
    expect(applyDeadZone(1)).toBeCloseTo(1);
    expect(applyDeadZone(-1)).toBeCloseTo(-1);
    expect(applyDeadZone(1.4)).toBeCloseTo(1); // out-of-range hardware
  });
});

describe("stickVector", () => {
  it("ignores drift near the center", () => {
    expect(stickVector(0.05, -0.08)).toEqual({ x: 0, y: 0 });
  });

  it("uses a circular zone: a diagonal is no faster than a straight push", () => {
    const straight = stickVector(1, 0);
    const diagonal = stickVector(1, 1);
    expect(Math.hypot(straight.x, straight.y)).toBeCloseTo(1);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
  });

  it("keeps the direction of the push", () => {
    const v = stickVector(0.3, -0.6);
    expect(Math.atan2(v.y, v.x)).toBeCloseTo(Math.atan2(-0.6, 0.3));
  });
});

describe("lookCurve", () => {
  it("is gentle near the center, full at the rim, and odd", () => {
    expect(lookCurve(0.5)).toBeCloseTo(0.25);
    expect(lookCurve(1)).toBe(1);
    expect(lookCurve(-0.5)).toBeCloseTo(-0.25);
  });
});

describe("GamepadInput.read", () => {
  const dt = 1 / 60;

  it("reports nothing from an untouched pad", () => {
    const frame = new GamepadInput().read(pad(), dt);
    expect(frame.active).toBe(false);
    expect(frame.forward).toBe(0);
    expect(frame.lookX).toBe(0);
    expect(frame.jump).toBe(false);
    expect(frame.breakBlock).toBe(false);
  });

  it("maps the left stick to movement: up is forward, right is right", () => {
    const frame = new GamepadInput().read(pad([0, -1, 0, 0]), dt);
    expect(frame.forward).toBeCloseTo(1);
    expect(frame.right).toBeCloseTo(0);
    expect(new GamepadInput().read(pad([1, 0, 0, 0]), dt).right).toBeCloseTo(1);
  });

  it("scales look by frame time, so turning speed doesn't depend on the frame rate", () => {
    const fast = new GamepadInput().read(pad([0, 0, 1, 0]), 1 / 120);
    const slow = new GamepadInput().read(pad([0, 0, 1, 0]), 1 / 30);
    expect(slow.lookX).toBeCloseTo(fast.lookX * 4);
    expect(fast.lookX).toBeGreaterThan(0);
  });

  it("holds jump and descend for as long as A and B are down", () => {
    const input = new GamepadInput();
    expect(input.read(pad([], [0]), dt).jump).toBe(true);
    expect(input.read(pad([], [0]), dt).jump).toBe(true);
    expect(input.read(pad([], [1]), dt).descend).toBe(true);
  });

  it("fires one-shot buttons once per press, not once per frame", () => {
    const input = new GamepadInput();
    expect(input.read(pad([], [3, 9, 2]), dt)).toMatchObject({
      inventory: true,
      pause: true,
      toggleFlight: true,
    });
    expect(input.read(pad([], [3, 9, 2]), dt)).toMatchObject({
      inventory: false,
      pause: false,
      toggleFlight: false,
    });
    input.read(pad(), dt);
    expect(input.read(pad([], [3]), dt).inventory).toBe(true);
  });

  it("steps the hotbar with the bumpers", () => {
    expect(new GamepadInput().read(pad([], [5]), dt).hotbarStep).toBe(1);
    expect(new GamepadInput().read(pad([], [4]), dt).hotbarStep).toBe(-1);
  });

  it("breaks at once on the trigger, then repeats while it's held", () => {
    const input = new GamepadInput();
    let fired = 0;
    for (let i = 0; i < 60; i++) {
      if (input.read(pad([], [], { 7: 0.9 }), dt).breakBlock) fired++;
    }
    // One second held at a 0.23 s cadence: the first hit plus about four.
    expect(fired).toBeGreaterThanOrEqual(4);
    expect(fired).toBeLessThanOrEqual(6);
    // Releasing re-arms it: the next pull acts immediately.
    input.read(pad(), dt);
    expect(input.read(pad([], [], { 7: 0.9 }), dt).breakBlock).toBe(true);
  });

  it("ignores a trigger that's only resting under a finger", () => {
    expect(new GamepadInput().read(pad([], [], { 6: 0.2 }), dt).placeBlock).toBe(false);
  });

  it("latches sprint on a stick click until the stick comes back to center", () => {
    const input = new GamepadInput();
    expect(input.read(pad([0, -1, 0, 0], [10]), dt).sprint).toBe(true);
    expect(input.read(pad([0, -1, 0, 0]), dt).sprint).toBe(true);
    expect(input.read(pad([0, 0, 0, 0]), dt).sprint).toBe(false);
    expect(input.read(pad([0, -1, 0, 0]), dt).sprint).toBe(false);
  });

  it("copes with a pad that reports fewer axes or buttons than the standard", () => {
    const frame = new GamepadInput().read({ axes: [0.9], buttons: [] }, dt);
    expect(frame.right).toBeGreaterThan(0.8);
    expect(frame.jump).toBe(false);
  });
});
