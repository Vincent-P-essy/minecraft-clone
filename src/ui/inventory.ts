import { BLOCKS, type BlockId, INVENTORY_BLOCKS } from "../world/blocks";
import { renderBlockIcon } from "./block-icon";

/** The creative inventory: every block in the game on one panel. Choosing
 * one drops it into the selected hotbar slot. */
export class Inventory {
  private readonly panel: HTMLDivElement;
  private open = false;
  onChoose: ((block: BlockId) => void) | undefined;
  onClose: (() => void) | undefined;

  constructor(parent: HTMLElement, atlas: HTMLCanvasElement) {
    this.panel = document.createElement("div");
    this.panel.id = "inventory";
    this.panel.className = "panel hidden";

    const header = document.createElement("div");
    header.className = "panel-header";
    const title = document.createElement("h2");
    title.textContent = "Blocks";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "✕";
    close.addEventListener("click", () => {
      this.onClose?.();
    });
    header.append(title, close);

    const grid = document.createElement("div");
    grid.className = "inventory-grid";
    for (const block of INVENTORY_BLOCKS) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "inventory-cell";
      cell.title = BLOCKS[block].name;
      cell.setAttribute("aria-label", BLOCKS[block].name);
      cell.dataset.block = block.toString();
      cell.appendChild(renderBlockIcon(atlas, block, 64));
      cell.addEventListener("click", () => {
        this.onChoose?.(block);
      });
      grid.appendChild(cell);
    }

    const hint = document.createElement("p");
    hint.className = "panel-hint";
    hint.textContent = "Pick a block to put it in the selected slot.";

    this.panel.append(header, grid, hint);
    // Clicks on the panel must not fall through to the game canvas.
    this.panel.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });
    parent.appendChild(this.panel);
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.panel.classList.toggle("hidden", !open);
  }

  get isOpen(): boolean {
    return this.open;
  }
}
