import * as THREE from "three";
import {
  ALL_TILE_KINDS,
  ATLAS_PIXELS,
  ATLAS_TILE_SIZE,
  TILE_COUNT,
  tileGridPosition,
} from "./atlas-layout";
import { buildNoisePixels, NOISE_SIZE } from "./noise-texture";
import { paintTile } from "./tile-painter";

export interface BlockTextureAtlas {
  readonly canvas: HTMLCanvasElement;
}

/** Lays every painted tile out on one small canvas — the UI crops its
 * block icons from here. */
export function createTextureAtlas(seed = 1): BlockTextureAtlas {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_PIXELS;
  canvas.height = ATLAS_PIXELS;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context is unavailable");

  for (const tile of ALL_TILE_KINDS) {
    const { col, row } = tileGridPosition(tile);
    const pixels = paintTile(tile, seed);
    const image = ctx.createImageData(ATLAS_TILE_SIZE, ATLAS_TILE_SIZE);
    image.data.set(pixels);
    ctx.putImageData(image, col * ATLAS_TILE_SIZE, row * ATLAS_TILE_SIZE);
  }
  return { canvas };
}

/** Builds a WebGL2 texture array — one 16x16 layer per tile kind, indexed
 * by TileKind. Greedy-meshed quads span many blocks, so the chunk shader
 * samples this with a repeating coordinate and a per-quad layer, which an
 * atlas can't do without bleeding into neighboring tiles. Crisp up close
 * (nearest magnification), calm at a distance (trilinear mipmaps). */
export function createBlockTextureArray(seed = 1, anisotropy = 1): THREE.DataArrayTexture {
  const size = ATLAS_TILE_SIZE;
  const layer = size * size * 4;
  const data = new Uint8Array(layer * TILE_COUNT);
  for (const tile of ALL_TILE_KINDS) {
    data.set(paintTile(tile, seed), tile * layer);
  }

  const texture = new THREE.DataArrayTexture(data, size, size, TILE_COUNT);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** The shared tileable noise texture (see noise-texture.ts). */
export function createNoiseTexture(seed = 1): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    buildNoisePixels(seed),
    NOISE_SIZE,
    NOISE_SIZE,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
