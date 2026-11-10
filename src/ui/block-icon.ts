import { BLOCKS, type BlockId } from "../world/blocks";
import { ATLAS_TILE_SIZE, tileForBlockFace, tileGridPosition } from "../render/atlas-layout";

const T = ATLAS_TILE_SIZE;

/** Draws a block the way the player thinks of it: a little isometric cube
 * with its real top and side textures, lit from the upper left. Plants are
 * drawn as the flat sprite they are. Everything is cropped from the atlas
 * canvas, so icons always match what's in the world. */
export function renderBlockIcon(
  atlas: HTMLCanvasElement,
  block: BlockId,
  size: number,
): HTMLCanvasElement {
  const icon = document.createElement("canvas");
  icon.width = size;
  icon.height = size;
  const ctx = icon.getContext("2d");
  if (!ctx) throw new Error("2D canvas context is unavailable");
  ctx.imageSmoothingEnabled = false;

  const tile = (face: "top" | "north" | "east"): { sx: number; sy: number } => {
    const { col, row } = tileGridPosition(tileForBlockFace(block, face));
    return { sx: col * T, sy: row * T };
  };

  if (BLOCKS[block].shape === "cross") {
    const { sx, sy } = tile("north");
    const pad = size * 0.08;
    ctx.drawImage(atlas, sx, sy, T, T, pad, pad, size - pad * 2, size - pad * 2);
    return icon;
  }

  // Cube corners in icon space.
  const half = size * 0.44;
  const cx = size / 2;
  const top = size * 0.05;
  const rise = half * 0.5;
  const side = size - top - rise * 2 - size * 0.04;
  const apex = { x: cx, y: top };
  const right = { x: cx + half, y: top + rise };
  const left = { x: cx - half, y: top + rise };
  const center = { x: cx, y: top + rise * 2 };

  // Each face is drawn on its own layer so "source-atop" shading can't
  // leak onto faces drawn before it.
  const layer = (draw: () => void): void => {
    const scratch = document.createElement("canvas");
    scratch.width = size;
    scratch.height = size;
    const sctx = scratch.getContext("2d");
    if (!sctx) return;
    sctx.imageSmoothingEnabled = false;
    drawOn = sctx;
    draw();
    drawOn = ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(scratch, 0, 0);
  };
  let drawOn = ctx;
  const faceOn = (
    source: { sx: number; sy: number },
    origin: { x: number; y: number },
    u: { x: number; y: number },
    v: { x: number; y: number },
    shade: number,
  ): void => {
    const target = drawOn;
    target.setTransform(u.x / T, u.y / T, v.x / T, v.y / T, origin.x, origin.y);
    target.drawImage(atlas, source.sx, source.sy, T, T, 0, 0, T, T);
    if (shade > 0) {
      target.globalCompositeOperation = "source-atop";
      target.fillStyle = `rgba(0, 0, 0, ${shade.toString()})`;
      target.fillRect(0, 0, T, T);
      target.globalCompositeOperation = "source-over";
    }
  };
  layer(() => {
    faceOn(
      tile("top"),
      apex,
      { x: right.x - apex.x, y: right.y - apex.y },
      { x: left.x - apex.x, y: left.y - apex.y },
      0,
    );
  });
  layer(() => {
    faceOn(
      tile("north"),
      left,
      { x: center.x - left.x, y: center.y - left.y },
      { x: 0, y: side },
      0.22,
    );
  });
  layer(() => {
    faceOn(
      tile("east"),
      center,
      { x: right.x - center.x, y: right.y - center.y },
      { x: 0, y: side },
      0.42,
    );
  });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return icon;
}
