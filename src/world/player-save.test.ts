import { describe, expect, it } from "vitest";
import type { KeyValueStorage } from "./edit-store";
import { loadPlayerSave, type PlayerSave, playerSaveKey, storePlayerSave } from "./player-save";

function memory(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

const save: PlayerSave = {
  x: 12.5,
  y: 64,
  z: -40.25,
  yaw: 1.2,
  pitch: -0.3,
  flying: true,
  time: 321,
  hotbar: [1, 2, 3, 14, 6, 17, 18, 16, 4],
  slot: 6,
};

describe("player save", () => {
  it("round-trips a save", () => {
    const storage = memory();
    storePlayerSave(storage, 7, save);
    expect(loadPlayerSave(storage, 7)).toEqual(save);
  });

  it("keeps worlds apart by seed", () => {
    const storage = memory();
    storePlayerSave(storage, 7, save);
    expect(loadPlayerSave(storage, 8)).toBeNull();
  });

  it("returns null when nothing was saved or the payload is corrupt", () => {
    const storage = memory();
    expect(loadPlayerSave(storage, 1)).toBeNull();
    storage.data.set(playerSaveKey(1), "{oops");
    expect(loadPlayerSave(storage, 1)).toBeNull();
  });

  it("rejects a save with missing or non-finite coordinates", () => {
    const storage = memory();
    for (const broken of [
      { ...save, x: "12" },
      { ...save, y: null },
      { ...save, yaw: undefined },
      { x: 1, y: 2 },
    ]) {
      storage.data.set(playerSaveKey(1), JSON.stringify(broken));
      expect(loadPlayerSave(storage, 1)).toBeNull();
    }
  });

  it("clamps the selected slot and tolerates a missing hotbar", () => {
    const storage = memory();
    storage.data.set(playerSaveKey(1), JSON.stringify({ ...save, slot: 42, hotbar: "nope" }));
    const loaded = loadPlayerSave(storage, 1);
    expect(loaded?.slot).toBe(8);
    expect(loaded?.hotbar).toEqual([]);
  });

  it("never throws when storage refuses the write", () => {
    expect(() => {
      storePlayerSave(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
        },
        1,
        save,
      );
    }).not.toThrow();
  });
});
