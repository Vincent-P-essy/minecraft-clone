import { mulberry32 } from "../world/rng";
import { ATLAS_TILE_SIZE, TileKind } from "./atlas-layout";

/** Every block texture, painted in code: 16x16 pixel art built from a
 * handful of primitives (mottled fills, strokes, cells, rings) and a seeded
 * PRNG. No image files ship with the game, and the whole set is a pure
 * function of the seed — which also means it's testable without a canvas.
 *
 * Alpha carries two things at once: below 0.5 a pixel is cut out (leaves,
 * plants, glass), and among opaque pixels a full 255 marks "this part
 * glows" on emissive blocks, while the non-glowing remainder sits at 170. */

const S = ATLAS_TILE_SIZE;
const DULL = 170;

type RGB = readonly [number, number, number];

class Tile {
  readonly data = new Uint8ClampedArray(S * S * 4);
  readonly rng: () => number;

  constructor(seed: number) {
    this.rng = mulberry32(seed);
  }

  set(x: number, y: number, c: RGB, alpha = 255): void {
    const px = ((x % S) + S) % S;
    const py = ((y % S) + S) % S;
    const i = (py * S + px) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = alpha;
  }

  setInside(x: number, y: number, c: RGB, alpha = 255): void {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    this.set(x, y, c, alpha);
  }

  alphaAt(x: number, y: number): number {
    return this.data[(y * S + x) * 4 + 3] ?? 0;
  }

  /** Multiplies a pixel's colour (shading, highlights). */
  shade(x: number, y: number, factor: number): void {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    this.data[i] = (this.data[i] ?? 0) * factor;
    this.data[i + 1] = (this.data[i + 1] ?? 0) * factor;
    this.data[i + 2] = (this.data[i + 2] ?? 0) * factor;
  }

  int(max: number): number {
    return Math.floor(this.rng() * max);
  }
}

/** Tileable smooth noise over the 16x16 tile, period `cells`. */
function tileNoise(rng: () => number, cells: number): (x: number, y: number) => number {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  return (x, y) => {
    const fx = (x / S) * cells;
    const fy = (y / S) * cells;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const at = (cx: number, cy: number): number =>
      lattice[(((cy % cells) + cells) % cells) * cells + (((cx % cells) + cells) % cells)] ?? 0;
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return top + (bottom - top) * sy;
  };
}

/** Fills the tile from a dark-to-light palette: broad shapes from smooth
 * noise, broken up by per-pixel grain. The backbone of most textures. */
function mottle(tile: Tile, palette: readonly RGB[], cells = 4, grain = 0.35, alpha = 255): void {
  const noise = tileNoise(tile.rng, cells);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = noise(x, y) * (1 - grain) + tile.rng() * grain;
      const level = Math.max(0, Math.min(palette.length - 1, Math.floor(v * palette.length)));
      tile.set(x, y, palette[level] ?? [255, 0, 255], alpha);
    }
  }
}

function speckle(tile: Tile, color: RGB, count: number, alpha = 255): void {
  for (let i = 0; i < count; i++) tile.set(tile.int(S), tile.int(S), color, alpha);
}

/** Irregular cells (cobbles, pebbles): each pixel belongs to its nearest
 * seed, shaded per cell, with dark seams where two cells meet. */
function cells(tile: Tile, count: number, palette: readonly RGB[], seam: RGB, alpha = 255): void {
  const seeds: { x: number; y: number; tone: number }[] = [];
  for (let i = 0; i < count; i++) {
    seeds.push({ x: tile.rng() * S, y: tile.rng() * S, tone: tile.int(palette.length) });
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let best = Infinity;
      let second = Infinity;
      let tone = 0;
      for (const seed of seeds) {
        // Wrapped distance, so the pattern tiles.
        const dx = Math.min(Math.abs(x - seed.x), S - Math.abs(x - seed.x));
        const dy = Math.min(Math.abs(y - seed.y), S - Math.abs(y - seed.y));
        const d = dx * dx + dy * dy;
        if (d < best) {
          second = best;
          best = d;
          tone = seed.tone;
        } else if (d < second) {
          second = d;
        }
      }
      const onSeam = Math.sqrt(second) - Math.sqrt(best) < 1.1;
      tile.set(x, y, onSeam ? seam : (palette[tone] ?? seam), alpha);
      if (!onSeam && tile.rng() < 0.18) tile.shade(x, y, 0.93 + tile.rng() * 0.14);
    }
  }
}

/** Vertical bark: each column keeps a tone for a while, then changes. */
function bark(tile: Tile, palette: readonly RGB[], knots: RGB | null): void {
  for (let x = 0; x < S; x++) {
    let tone = tile.int(palette.length);
    for (let y = 0; y < S; y++) {
      if (tile.rng() < 0.16) tone = tile.int(palette.length);
      tile.set(x, y, palette[tone] ?? [0, 0, 0]);
    }
    if (tile.rng() < 0.35) {
      // A deep groove running most of the column.
      const from = tile.int(6);
      const to = S - tile.int(6);
      for (let y = from; y < to; y++) tile.shade(x, y, 0.78);
    }
  }
  if (knots) {
    for (let i = 0; i < 2; i++) {
      const kx = 2 + tile.int(S - 4);
      const ky = 2 + tile.int(S - 4);
      tile.set(kx, ky, knots);
      tile.set(kx + 1, ky, knots);
    }
  }
}

/** End grain: square-ish growth rings inside a ring of bark. */
function rings(tile: Tile, light: RGB, dark: RGB, rind: RGB): void {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d =
        Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)) * 0.6 + Math.hypot(x - 7.5, y - 7.5) * 0.4;
      if (d > 7) tile.set(x, y, rind);
      else tile.set(x, y, Math.floor(d) % 2 === 0 ? light : dark);
      if (tile.rng() < 0.12) tile.shade(x, y, 0.92);
    }
  }
}

/** Foliage: clumps of leaves in a few greens, with holes punched through. */
function foliage(tile: Tile, palette: readonly RGB[], holes: number): void {
  const noise = tileNoise(tile.rng, 5);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = noise(x, y) * 0.55 + tile.rng() * 0.45;
      if (v < holes) {
        tile.set(x, y, palette[0] ?? [0, 0, 0], 0);
        continue;
      }
      const level = Math.min(
        palette.length - 1,
        Math.floor(((v - holes) / (1 - holes)) * palette.length),
      );
      tile.set(x, y, palette[level] ?? [0, 0, 0]);
    }
  }
}

/** Courses of bricks with staggered joints, a lit top edge and a shadowed
 * bottom edge so they read as raised. */
function bricks(
  tile: Tile,
  brickW: number,
  brickH: number,
  palette: readonly RGB[],
  mortar: RGB,
): void {
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / brickH);
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let x = 0; x < S; x++) {
      const bx = Math.floor((x + offset) / brickW);
      const inY = y % brickH;
      const inX = (x + offset) % brickW;
      if (inY === brickH - 1 || inX === brickW - 1) {
        tile.set(x, y, mortar);
        continue;
      }
      const tone = (bx * 7 + row * 13) % palette.length;
      tile.set(x, y, palette[tone] ?? mortar);
      if (inY === 0) tile.shade(x, y, 1.1);
      if (inY === brickH - 2) tile.shade(x, y, 0.88);
      if (tile.rng() < 0.15) tile.shade(x, y, 0.92 + tile.rng() * 0.12);
    }
  }
}

/** Scatters ore nuggets (2-4 px blobs) over an already painted stone tile. */
function nuggets(tile: Tile, count: number, body: RGB, highlight: RGB, alpha: number): void {
  for (let i = 0; i < count; i++) {
    const cx = 1 + tile.int(S - 3);
    const cy = 1 + tile.int(S - 3);
    tile.set(cx, cy, body, alpha);
    tile.set(cx + 1, cy, body, alpha);
    tile.set(cx, cy + 1, body, alpha);
    if (tile.rng() < 0.6) tile.set(cx + 1, cy + 1, body, alpha);
    if (tile.rng() < 0.5) tile.set(cx - 1, cy, body, alpha);
    tile.set(cx, cy, highlight, alpha);
  }
}

/** Gives fully transparent pixels the average opaque colour, so mipmaps
 * and bilinear filtering don't pull a dark fringe in from the cut-out. */
function bleedCutout(tile: Tile): void {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < S * S; i++) {
    if ((tile.data[i * 4 + 3] ?? 0) > 0) {
      r += tile.data[i * 4] ?? 0;
      g += tile.data[i * 4 + 1] ?? 0;
      b += tile.data[i * 4 + 2] ?? 0;
      n++;
    }
  }
  if (n === 0) return;
  for (let i = 0; i < S * S; i++) {
    if ((tile.data[i * 4 + 3] ?? 0) === 0) {
      tile.data[i * 4] = r / n;
      tile.data[i * 4 + 1] = g / n;
      tile.data[i * 4 + 2] = b / n;
    }
  }
}

const GRASS: readonly RGB[] = [
  [62, 118, 44],
  [74, 134, 50],
  [86, 148, 56],
  [100, 162, 64],
];
const DIRT: readonly RGB[] = [
  [92, 62, 40],
  [108, 74, 48],
  [122, 86, 56],
  [136, 98, 66],
];
const STONE: readonly RGB[] = [
  [104, 104, 110],
  [118, 118, 124],
  [130, 130, 136],
  [142, 142, 148],
];

function paintDirt(tile: Tile): void {
  mottle(tile, DIRT, 5, 0.5);
  speckle(tile, [150, 114, 80], 5);
  speckle(tile, [78, 52, 34], 6);
}

function paintStone(tile: Tile): void {
  mottle(tile, STONE, 3, 0.3);
  // A few hairline cracks.
  for (let i = 0; i < 3; i++) {
    let x = tile.int(S);
    let y = tile.int(S);
    const len = 3 + tile.int(5);
    for (let s = 0; s < len; s++) {
      tile.set(x, y, [88, 88, 96]);
      x += 1;
      if (tile.rng() < 0.4) y += tile.rng() < 0.5 ? 1 : -1;
    }
  }
}

/** A soil tile with a ragged cap of grass or snow hanging over its top. */
function paintCapped(tile: Tile, cap: readonly RGB[], lip: RGB): void {
  paintDirt(tile);
  for (let x = 0; x < S; x++) {
    const depth = 3 + tile.int(3);
    for (let y = 0; y < depth; y++) {
      tile.set(x, y, cap[tile.int(cap.length)] ?? lip);
    }
    tile.set(x, depth, lip);
  }
}

function paintPlantBlades(tile: Tile, palette: readonly RGB[], blades: number): void {
  for (let i = 0; i < blades; i++) {
    let x = 1 + tile.int(S - 2);
    const height = 6 + tile.int(9);
    const lean = tile.rng() < 0.5 ? -1 : 1;
    const color = palette[tile.int(palette.length)] ?? [0, 0, 0];
    for (let h = 0; h < height; h++) {
      tile.setInside(x, S - 1 - h, color);
      if (h > 3 && tile.rng() < 0.22) x += lean;
    }
  }
}

function paintStem(tile: Tile, top: number): void {
  const stem: RGB = [64, 128, 48];
  for (let y = top; y < S; y++) tile.set(8, y, stem);
  tile.set(7, 12, stem);
  tile.set(6, 11, [78, 146, 56]);
  tile.set(9, 13, stem);
  tile.set(10, 12, [78, 146, 56]);
}

type Painter = (tile: Tile) => void;

const PAINTERS: Record<TileKind, Painter> = {
  [TileKind.GRASS_TOP]: (t) => {
    mottle(t, GRASS, 5, 0.55);
    speckle(t, [118, 178, 76], 10);
    speckle(t, [54, 104, 40], 8);
  },
  [TileKind.GRASS_SIDE]: (t) => {
    paintCapped(t, GRASS, [52, 98, 38]);
  },
  [TileKind.DIRT]: paintDirt,
  [TileKind.STONE]: paintStone,
  [TileKind.SAND]: (t) => {
    mottle(
      t,
      [
        [206, 186, 120],
        [218, 198, 132],
        [228, 208, 142],
      ],
      4,
      0.45,
    );
    speckle(t, [240, 224, 164], 8);
    speckle(t, [190, 168, 104], 6);
  },
  [TileKind.WATER]: (t) => {
    mottle(
      t,
      [
        [40, 104, 176],
        [52, 120, 190],
        [66, 136, 202],
      ],
      3,
      0.2,
    );
    speckle(t, [150, 200, 236], 5);
  },
  [TileKind.WOOD_SIDE]: (t) => {
    bark(
      t,
      [
        [84, 60, 36],
        [98, 70, 42],
        [110, 80, 50],
      ],
      [62, 44, 28],
    );
  },
  [TileKind.WOOD_TOP]: (t) => {
    rings(t, [184, 148, 96], [156, 120, 74], [92, 66, 40]);
  },
  [TileKind.LEAVES]: (t) => {
    foliage(
      t,
      [
        [38, 88, 34],
        [50, 106, 40],
        [62, 124, 46],
        [78, 142, 54],
      ],
      0.2,
    );
  },
  [TileKind.BEDROCK]: (t) => {
    mottle(
      t,
      [
        [22, 22, 26],
        [44, 44, 50],
        [70, 70, 78],
        [34, 34, 40],
      ],
      6,
      0.6,
    );
  },
  [TileKind.SNOW]: (t) => {
    mottle(
      t,
      [
        [222, 232, 244],
        [236, 242, 250],
        [246, 250, 255],
      ],
      3,
      0.3,
    );
    speckle(t, [255, 255, 255], 8);
  },
  [TileKind.TALL_GRASS]: (t) => {
    paintPlantBlades(t, GRASS, 11);
  },
  [TileKind.FLOWER_RED]: (t) => {
    paintStem(t, 6);
    const petal: RGB = [226, 58, 44];
    for (const [x, y] of [
      [7, 3],
      [8, 3],
      [6, 4],
      [9, 4],
      [6, 5],
      [9, 5],
      [7, 6],
      [8, 6],
      [7, 2],
      [10, 4],
      [5, 5],
    ] as const) {
      t.set(x, y, petal);
    }
    t.set(7, 4, [255, 210, 70]);
    t.set(8, 4, [255, 190, 60]);
    t.set(7, 5, [255, 190, 60]);
    t.set(8, 5, [250, 120, 50]);
    t.set(6, 3, [250, 110, 90]);
  },
  [TileKind.FLOWER_YELLOW]: (t) => {
    paintStem(t, 7);
    const petal: RGB = [250, 214, 60];
    for (const [x, y] of [
      [7, 3],
      [8, 3],
      [6, 4],
      [9, 4],
      [5, 5],
      [10, 5],
      [6, 6],
      [9, 6],
      [7, 7],
      [8, 7],
      [6, 5],
      [9, 5],
    ] as const) {
      t.set(x, y, petal);
    }
    t.set(7, 4, [255, 240, 150]);
    t.set(8, 4, [255, 240, 150]);
    t.set(7, 5, [224, 130, 40]);
    t.set(8, 5, [224, 130, 40]);
    t.set(7, 6, [240, 170, 50]);
    t.set(8, 6, [240, 170, 50]);
  },
  [TileKind.FLOWER_BLUE]: (t) => {
    paintStem(t, 4);
    const bell: RGB = [86, 130, 240];
    const pale: RGB = [150, 186, 255];
    for (const [x, y] of [
      [5, 5],
      [6, 5],
      [5, 6],
      [6, 6],
      [10, 7],
      [11, 7],
      [10, 8],
      [11, 8],
      [6, 9],
      [7, 9],
      [6, 10],
    ] as const) {
      t.set(x, y, bell);
    }
    t.set(5, 5, pale);
    t.set(10, 7, pale);
    t.set(6, 9, pale);
    t.set(7, 4, [64, 128, 48]);
    t.set(9, 6, [64, 128, 48]);
    t.set(8, 3, [120, 160, 250]);
    t.set(8, 2, pale);
  },
  [TileKind.PLANKS]: (t) => {
    const palette: readonly RGB[] = [
      [160, 122, 72],
      [174, 134, 80],
      [186, 146, 90],
    ];
    for (let y = 0; y < S; y++) {
      const board = Math.floor(y / 4);
      const base = palette[(board * 5 + 1) % palette.length] ?? [0, 0, 0];
      for (let x = 0; x < S; x++) {
        t.set(x, y, base);
        if (t.rng() < 0.2) t.shade(x, y, 0.9 + t.rng() * 0.16);
        if (y % 4 === 3) t.shade(x, y, 0.66);
      }
      // One staggered butt joint per board.
      if (y % 4 !== 3) t.shade((board * 7 + 3) % S, y, 0.68);
    }
  },
  [TileKind.COBBLE]: (t) => {
    cells(
      t,
      11,
      [
        [112, 112, 118],
        [128, 128, 134],
        [142, 142, 148],
        [98, 98, 106],
      ],
      [66, 66, 74],
    );
  },
  [TileKind.STONE_BRICK]: (t) => {
    bricks(
      t,
      8,
      8,
      [
        [122, 122, 128],
        [132, 132, 138],
        [114, 114, 122],
      ],
      [76, 76, 84],
    );
  },
  [TileKind.GLASS]: (t) => {
    const frame: RGB = [214, 236, 244];
    for (let i = 0; i < S; i++) {
      t.set(i, 0, frame);
      t.set(i, S - 1, frame);
      t.set(0, i, frame);
      t.set(S - 1, i, frame);
    }
    // A glint across one corner.
    for (const [x, y] of [
      [3, 5],
      [4, 4],
      [5, 3],
      [4, 7],
      [5, 6],
      [6, 5],
      [7, 4],
      [11, 12],
      [12, 11],
    ] as const) {
      t.set(x, y, [240, 250, 255]);
    }
  },
  [TileKind.LANTERN]: (t) => {
    const iron: RGB = [52, 46, 44];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const border = x < 2 || y < 2 || x >= S - 2 || y >= S - 2;
        const bar = x === 7 || x === 8 || y === 7 || y === 8;
        if (border || bar) {
          t.set(x, y, iron, DULL);
          if (t.rng() < 0.2) t.shade(x, y, 1.25);
        } else {
          const d = Math.hypot(x - 7.5, y - 7.5) / 8;
          t.set(x, y, [255, 226 - d * 70, 150 - d * 90]);
        }
      }
    }
  },
  [TileKind.COAL_ORE]: (t) => {
    paintStone(t);
    nuggets(t, 6, [34, 34, 38], [70, 70, 78], 255);
  },
  [TileKind.GOLD_ORE]: (t) => {
    paintStone(t);
    nuggets(t, 5, [226, 178, 52], [255, 236, 140], 255);
  },
  [TileKind.CRYSTAL]: (t) => {
    mottle(
      t,
      [
        [46, 44, 62],
        [58, 56, 76],
        [70, 68, 90],
      ],
      3,
      0.35,
      DULL,
    );
    // Shards: short diagonal slivers of light.
    for (let i = 0; i < 7; i++) {
      const x = 1 + t.int(S - 3);
      const y = 2 + t.int(S - 4);
      const violet = t.rng() < 0.35;
      const core: RGB = violet ? [214, 150, 255] : [130, 244, 255];
      const rim: RGB = violet ? [150, 90, 230] : [60, 190, 232];
      t.set(x, y, core);
      t.set(x + 1, y - 1, core);
      t.set(x, y + 1, rim);
      t.set(x + 1, y, rim);
      if (t.rng() < 0.5) t.set(x + 2, y - 2, rim);
    }
  },
  [TileKind.PALE_WOOD_SIDE]: (t) => {
    mottle(
      t,
      [
        [206, 204, 194],
        [220, 218, 208],
        [232, 230, 222],
      ],
      3,
      0.3,
    );
    // Dark lenticels: short horizontal dashes.
    for (let i = 0; i < 9; i++) {
      const x = t.int(S);
      const y = t.int(S);
      const len = 2 + t.int(3);
      for (let s = 0; s < len; s++) t.set(x + s, y, [58, 54, 50]);
    }
  },
  [TileKind.PALE_WOOD_TOP]: (t) => {
    rings(t, [226, 210, 170], [202, 184, 142], [214, 212, 202]);
  },
  [TileKind.AUTUMN_LEAVES]: (t) => {
    foliage(
      t,
      [
        [150, 52, 22],
        [198, 86, 26],
        [228, 126, 30],
        [244, 172, 48],
      ],
      0.2,
    );
  },
  [TileKind.PINE_WOOD_SIDE]: (t) => {
    bark(
      t,
      [
        [58, 38, 26],
        [70, 46, 30],
        [82, 54, 36],
      ],
      null,
    );
  },
  [TileKind.PINE_WOOD_TOP]: (t) => {
    rings(t, [168, 124, 78], [136, 96, 58], [64, 42, 28]);
  },
  [TileKind.PINE_LEAVES]: (t) => {
    foliage(
      t,
      [
        [22, 62, 44],
        [30, 76, 52],
        [38, 92, 60],
        [50, 108, 70],
      ],
      0.14,
    );
    // Needles: short diagonal ticks of the lightest green.
    for (let i = 0; i < 12; i++) {
      const x = t.int(S);
      const y = t.int(S);
      if (t.alphaAt(x, y) === 0) continue;
      t.set(x, y, [64, 126, 82]);
      if (t.alphaAt((x + 1) % S, (y + 1) % S) !== 0) t.set(x + 1, y + 1, [44, 100, 66]);
    }
  },
  [TileKind.CACTUS_SIDE]: (t) => {
    for (let x = 0; x < S; x++) {
      const rib = x % 4;
      const tone: RGB = rib === 0 ? [44, 106, 48] : rib === 2 ? [78, 152, 70] : [60, 130, 58];
      for (let y = 0; y < S; y++) {
        t.set(x, y, tone);
        if (t.rng() < 0.12) t.shade(x, y, 0.9);
      }
    }
    for (let y = 1; y < S; y += 4) {
      for (let x = 2; x < S; x += 4) t.set(x, y + ((x >> 2) % 2) * 2, [232, 232, 200]);
    }
  },
  [TileKind.CACTUS_TOP]: (t) => {
    rings(t, [86, 160, 76], [64, 134, 60], [44, 106, 48]);
  },
  [TileKind.GRAVEL]: (t) => {
    cells(
      t,
      22,
      [
        [126, 122, 118],
        [146, 140, 134],
        [108, 104, 104],
        [136, 124, 112],
      ],
      [84, 80, 80],
    );
  },
  [TileKind.ICE]: (t) => {
    mottle(
      t,
      [
        [148, 196, 236],
        [164, 208, 242],
        [182, 220, 248],
      ],
      3,
      0.2,
    );
    for (let i = 0; i < 4; i++) {
      let x = t.int(S);
      let y = t.int(S);
      for (let s = 0; s < 4 + t.int(4); s++) {
        t.set(x, y, [230, 244, 255]);
        x += 1;
        y += t.rng() < 0.6 ? 1 : 0;
      }
    }
  },
  [TileKind.BRICK]: (t) => {
    bricks(
      t,
      8,
      4,
      [
        [156, 74, 56],
        [170, 84, 62],
        [142, 66, 52],
        [164, 92, 70],
      ],
      [196, 186, 172],
    );
  },
  [TileKind.SANDSTONE_SIDE]: (t) => {
    const bands: readonly RGB[] = [
      [212, 190, 126],
      [200, 176, 112],
      [222, 202, 140],
      [190, 164, 102],
    ];
    let band = 0;
    for (let y = 0; y < S; y++) {
      if (y % 3 === 0 || t.rng() < 0.2) band = t.int(bands.length);
      for (let x = 0; x < S; x++) {
        t.set(x, y, bands[band] ?? [0, 0, 0]);
        if (t.rng() < 0.14) t.shade(x, y, 0.93 + t.rng() * 0.12);
      }
    }
  },
  [TileKind.SANDSTONE_TOP]: (t) => {
    mottle(
      t,
      [
        [204, 182, 118],
        [216, 194, 130],
        [226, 206, 142],
      ],
      3,
      0.25,
    );
  },
  [TileKind.DRY_BUSH]: (t) => {
    const twig: RGB = [122, 90, 52];
    const pale: RGB = [156, 122, 76];
    for (let i = 0; i < 6; i++) {
      let x = 6 + t.int(4);
      const lean = t.rng() < 0.5 ? -1 : 1;
      const height = 6 + t.int(7);
      for (let h = 0; h < height; h++) {
        t.setInside(x, S - 1 - h, h > height - 3 ? pale : twig);
        if (h > 1 && t.rng() < 0.55) x += lean;
      }
    }
  },
  [TileKind.FROSTED_GRASS_SIDE]: (t) => {
    paintCapped(
      t,
      [
        [236, 242, 250],
        [246, 250, 255],
        [224, 234, 246],
      ],
      [190, 204, 222],
    );
  },
  [TileKind.GLOWSHROOM]: (t) => {
    const stem: RGB = [206, 214, 204];
    for (let y = 9; y < S; y++) {
      t.set(7, y, stem, DULL);
      t.set(8, y, stem, DULL);
    }
    for (let y = 4; y <= 9; y++) {
      const half = y < 6 ? y - 2 : y < 9 ? 5 : 4;
      for (let x = 8 - half; x < 8 + half; x++) {
        const edge = x === 8 - half || x === 8 + half - 1 || y === 4;
        t.set(x, y, edge ? [40, 170, 190] : [96, 236, 228]);
      }
    }
    t.set(6, 6, [220, 255, 250]);
    t.set(10, 7, [220, 255, 250]);
    t.set(8, 5, [220, 255, 250]);
    // A smaller cap beside it.
    for (let x = 11; x <= 13; x++) t.set(x, 11, [96, 236, 228]);
    t.set(12, 10, [150, 250, 240]);
    for (let y = 12; y < S; y++) t.set(12, y, stem, DULL);
  },
  [TileKind.CLAY]: (t) => {
    mottle(
      t,
      [
        [142, 150, 164],
        [154, 162, 176],
        [164, 172, 186],
      ],
      3,
      0.2,
    );
  },
  [TileKind.LANTERN_TOP]: (t) => {
    const iron: RGB = [52, 46, 44];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const inner = x >= 5 && x < 11 && y >= 5 && y < 11;
        if (inner) t.set(x, y, [255, 214, 130]);
        else {
          t.set(x, y, iron, DULL);
          if (t.rng() < 0.2) t.shade(x, y, 1.25);
        }
      }
    }
  },
};

/** RGBA pixels (16x16, row 0 at the top) for one tile. */
export function paintTile(tile: TileKind, seed: number): Uint8ClampedArray {
  const canvas = new Tile(seed * 31 + tile * 7919 + 17);
  PAINTERS[tile](canvas);
  bleedCutout(canvas);
  return canvas.data;
}
