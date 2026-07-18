import { BlockId, PLACEABLE_BLOCKS } from "../world/blocks";
import { ATLAS_TILE_SIZE, tileForBlockFace, tileGridPosition } from "../render/atlas-layout";

const ICON_SIZE = 40;

function blockAtIndex(index: number): BlockId {
  const block = PLACEABLE_BLOCKS[index];
  if (block === undefined) throw new Error(`hotbar index ${index.toString()} out of range`);
  return block;
}

function renderTileIcon(atlasCanvas: HTMLCanvasElement, blockId: BlockId): HTMLCanvasElement {
  const icon = document.createElement("canvas");
  icon.width = ICON_SIZE;
  icon.height = ICON_SIZE;
  const ctx = icon.getContext("2d");
  if (!ctx) throw new Error("2D canvas context is unavailable");
  ctx.imageSmoothingEnabled = false;

  const { col, row } = tileGridPosition(tileForBlockFace(blockId, "east"));
  ctx.drawImage(
    atlasCanvas,
    col * ATLAS_TILE_SIZE,
    row * ATLAS_TILE_SIZE,
    ATLAS_TILE_SIZE,
    ATLAS_TILE_SIZE,
    0,
    0,
    ICON_SIZE,
    ICON_SIZE,
  );
  icon.style.width = "100%";
  icon.style.height = "100%";
  return icon;
}

/** The 9-slot block picker: click, number keys 1-9, or scroll to select. */
export class Hotbar {
  private readonly container: HTMLElement;
  private selectedIndex = 0;
  private selectedBlockId: BlockId = blockAtIndex(0);

  constructor(container: HTMLElement, atlasCanvas: HTMLCanvasElement) {
    this.container = container;

    PLACEABLE_BLOCKS.forEach((blockId, i) => {
      const slot = document.createElement("div");
      slot.className = "hotbar-slot";

      const key = document.createElement("span");
      key.className = "hotbar-key";
      key.textContent = (i + 1).toString();
      slot.appendChild(key);
      slot.appendChild(renderTileIcon(atlasCanvas, blockId));

      slot.addEventListener("click", () => {
        this.select(i);
      });
      this.container.appendChild(slot);
    });

    this.applySelectionStyle();

    window.addEventListener("keydown", (e) => {
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= PLACEABLE_BLOCKS.length) {
        this.select(n - 1);
      }
    });

    window.addEventListener("wheel", (e) => {
      const direction = e.deltaY > 0 ? 1 : -1;
      this.select(
        (this.selectedIndex + direction + PLACEABLE_BLOCKS.length) % PLACEABLE_BLOCKS.length,
      );
    });
  }

  private select(index: number): void {
    this.selectedIndex = index;
    this.selectedBlockId = blockAtIndex(index);
    this.applySelectionStyle();
  }

  private applySelectionStyle(): void {
    Array.from(this.container.children).forEach((child, i) => {
      child.classList.toggle("selected", i === this.selectedIndex);
    });
  }

  get selectedBlock(): BlockId {
    return this.selectedBlockId;
  }
}
