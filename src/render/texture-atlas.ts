import * as THREE from "three";
import { ATLAS_PIXELS, ATLAS_TILE_SIZE, TileKind, tileGridPosition } from "./atlas-layout";
import { mulberry32 } from "../world/rng";

interface TileStyle {
  readonly base: readonly [number, number, number];
  readonly alpha: number;
  readonly speckleAmount: number;
}

const TILE_STYLES: Record<TileKind, TileStyle> = {
  [TileKind.GRASS_TOP]: { base: [86, 140, 58], alpha: 255, speckleAmount: 18 },
  [TileKind.GRASS_SIDE]: { base: [122, 84, 51], alpha: 255, speckleAmount: 14 },
  [TileKind.DIRT]: { base: [122, 84, 51], alpha: 255, speckleAmount: 16 },
  [TileKind.STONE]: { base: [130, 130, 134], alpha: 255, speckleAmount: 16 },
  [TileKind.SAND]: { base: [219, 196, 120], alpha: 255, speckleAmount: 10 },
  [TileKind.WATER]: { base: [59, 111, 209], alpha: 175, speckleAmount: 8 },
  [TileKind.WOOD_SIDE]: { base: [95, 66, 40], alpha: 255, speckleAmount: 6 },
  [TileKind.WOOD_TOP]: { base: [176, 138, 89], alpha: 255, speckleAmount: 6 },
  [TileKind.LEAVES]: { base: [58, 117, 45], alpha: 215, speckleAmount: 22 },
  [TileKind.BEDROCK]: { base: [40, 40, 44], alpha: 255, speckleAmount: 24 },
  [TileKind.SNOW]: { base: [235, 240, 245], alpha: 255, speckleAmount: 10 },
};

function paintSpeckles(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  x: number,
  y: number,
  style: TileStyle,
): void {
  const [r, g, b] = style.base;
  for (let i = 0; i < style.speckleAmount; i++) {
    const px = x + Math.floor(rng() * ATLAS_TILE_SIZE);
    const py = y + Math.floor(rng() * ATLAS_TILE_SIZE);
    const delta = Math.floor((rng() - 0.5) * 40);
    ctx.fillStyle = `rgba(${clamp255(r + delta)}, ${clamp255(g + delta)}, ${clamp255(b + delta)}, ${(style.alpha / 255).toString()})`;
    ctx.fillRect(px, py, 1, 1);
  }
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, v));
}

function paintTile(
  ctx: CanvasRenderingContext2D,
  seed: number,
  tile: TileKind,
  style: TileStyle,
): void {
  const { col, row } = tileGridPosition(tile);
  const x = col * ATLAS_TILE_SIZE;
  const y = row * ATLAS_TILE_SIZE;
  const [r, g, b] = style.base;

  ctx.fillStyle = `rgba(${r.toString()}, ${g.toString()}, ${b.toString()}, ${(style.alpha / 255).toString()})`;
  ctx.fillRect(x, y, ATLAS_TILE_SIZE, ATLAS_TILE_SIZE);

  const rng = mulberry32(seed + tile * 7919);
  paintSpeckles(ctx, rng, x, y, style);

  if (tile === TileKind.GRASS_SIDE) {
    ctx.fillStyle = "rgba(86, 140, 58, 1)";
    ctx.fillRect(x, y, ATLAS_TILE_SIZE, 4);
    const grassRng = mulberry32(seed + 101);
    for (let i = 0; i < 6; i++) {
      const px = x + Math.floor(grassRng() * ATLAS_TILE_SIZE);
      ctx.fillStyle = "rgba(70, 120, 46, 1)";
      ctx.fillRect(px, y + 3 + Math.floor(grassRng() * 2), 1, 1);
    }
  }

  if (tile === TileKind.WOOD_TOP) {
    ctx.strokeStyle = "rgba(120, 90, 55, 0.9)";
    ctx.lineWidth = 1;
    const cx = x + ATLAS_TILE_SIZE / 2;
    const cy = y + ATLAS_TILE_SIZE / 2;
    for (const radius of [2, 4, 6]) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (tile === TileKind.WOOD_SIDE) {
    const barkRng = mulberry32(seed + 202);
    ctx.strokeStyle = "rgba(60, 42, 26, 0.8)";
    for (let i = 0; i < 5; i++) {
      const px = x + Math.floor(barkRng() * ATLAS_TILE_SIZE);
      ctx.beginPath();
      ctx.moveTo(px, y);
      ctx.lineTo(px, y + ATLAS_TILE_SIZE);
      ctx.stroke();
    }
  }
}

export interface BlockTextureAtlas {
  readonly texture: THREE.Texture;
  readonly canvas: HTMLCanvasElement;
}

/** Draws every block face texture procedurally onto one small canvas —
 * no external art assets, and the whole atlas is reproducible from a seed. */
export function createTextureAtlas(seed = 1): BlockTextureAtlas {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_PIXELS;
  canvas.height = ATLAS_PIXELS;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context is unavailable");

  ctx.imageSmoothingEnabled = false;
  for (const [tileKey, style] of Object.entries(TILE_STYLES)) {
    paintTile(ctx, seed, Number(tileKey) as TileKind, style);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  return { texture, canvas };
}
