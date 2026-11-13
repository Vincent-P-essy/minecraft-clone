import { describe, expect, it } from "vitest";
import { BLOCKS, BlockId } from "../world/blocks";
import { SoundEngine, soundMaterialFor } from "./sound";

describe("soundMaterialFor", () => {
  it("gives every block a material", () => {
    for (const def of Object.values(BLOCKS)) {
      expect(typeof soundMaterialFor(def.id)).toBe("string");
    }
  });

  it("maps blocks to what they sound like", () => {
    expect(soundMaterialFor(BlockId.STONE)).toBe("stone");
    expect(soundMaterialFor(BlockId.COBBLE)).toBe("stone");
    expect(soundMaterialFor(BlockId.GRASS)).toBe("soil");
    expect(soundMaterialFor(BlockId.SAND)).toBe("sand");
    expect(soundMaterialFor(BlockId.PLANKS)).toBe("wood");
    expect(soundMaterialFor(BlockId.LEAVES)).toBe("leaf");
    expect(soundMaterialFor(BlockId.GLASS)).toBe("glass");
    expect(soundMaterialFor(BlockId.SNOW)).toBe("snow");
  });
});

describe("SoundEngine before it is unlocked", () => {
  it("every call is a silent no-op (no AudioContext exists until a user gesture)", () => {
    const sound = new SoundEngine();
    expect(() => {
      sound.setVolume(0.5);
      sound.step(BlockId.GRASS);
      sound.breakBlock(BlockId.GLASS);
      sound.placeBlock(BlockId.STONE);
      sound.jump();
      sound.land(12, BlockId.SAND);
      sound.splash(true);
      sound.click();
      sound.select();
      sound.setPaused(true);
      sound.thunder();
      sound.discover();
      sound.update({ night: 1, underwater: false, cave: 0, speed: 3, rain: 0.5, sheltered: true });
    }).not.toThrow();
  });
});
