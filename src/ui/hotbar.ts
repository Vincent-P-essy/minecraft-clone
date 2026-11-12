import { BLOCKS, type BlockId, INVENTORY_BLOCKS, PLACEABLE_BLOCKS } from "../world/blocks";
import { renderBlockIcon } from "./block-icon";

export const HOTBAR_SLOTS = 9;
const ICON_SIZE = 64;

/** Validates a stored hotbar: nine known, placeable blocks or nothing. */
export function sanitizeHotbar(raw: unknown): BlockId[] | null {
  if (!Array.isArray(raw) || raw.length !== HOTBAR_SLOTS) return null;
  const allowed = new Set<number>(INVENTORY_BLOCKS);
  const out: BlockId[] = [];
  for (const value of raw) {
    if (typeof value !== "number" || !allowed.has(value)) return null;
    out.push(value as BlockId);
  }
  return out;
}

/** The 9-slot block picker: click, number keys 1-9, or scroll to select.
 * Slots are filled from the creative inventory. */
export class Hotbar {
  private readonly container: HTMLElement;
  private readonly atlas: HTMLCanvasElement;
  private readonly slots: BlockId[];
  private readonly elements: HTMLElement[] = [];
  private selectedIndex = 0;
  private readonly blockName: (name: string) => string;
  /** Fired when the selection or a slot's contents change. */
  onChange: (() => void) | undefined;
  /** Set false while a menu is open so keys and scroll don't reach it. */
  enabled = true;

  constructor(
    container: HTMLElement,
    atlas: HTMLCanvasElement,
    initial?: BlockId[] | null,
    blockName: (name: string) => string = (name) => name,
  ) {
    this.blockName = blockName;
    this.container = container;
    this.atlas = atlas;
    this.slots = initial ? [...initial] : [...PLACEABLE_BLOCKS];

    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const slot = document.createElement("div");
      slot.className = "hotbar-slot";
      slot.addEventListener("click", () => {
        this.select(i);
      });
      this.container.appendChild(slot);
      this.elements.push(slot);
      this.renderSlot(i);
    }
    this.applySelectionStyle();

    window.addEventListener("keydown", (e) => {
      if (!this.enabled) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= HOTBAR_SLOTS) this.select(n - 1);
    });

    window.addEventListener(
      "wheel",
      (e) => {
        if (!this.enabled) return;
        this.cycle(e.deltaY > 0 ? 1 : -1);
      },
      { passive: true },
    );
  }

  private renderSlot(index: number): void {
    const slot = this.elements[index];
    const block = this.slots[index];
    if (!slot || block === undefined) return;
    slot.replaceChildren();
    const key = document.createElement("span");
    key.className = "hotbar-key";
    key.textContent = (index + 1).toString();
    slot.append(key, renderBlockIcon(this.atlas, block, ICON_SIZE));
    slot.title = this.blockName(BLOCKS[block].name);
  }

  select(index: number): void {
    if (index === this.selectedIndex || index < 0 || index >= HOTBAR_SLOTS) return;
    this.selectedIndex = index;
    this.applySelectionStyle();
    this.onChange?.();
  }

  /** Moves the selection one slot left (-1) or right (+1), wrapping. */
  cycle(direction: -1 | 1): void {
    this.select((this.selectedIndex + direction + HOTBAR_SLOTS) % HOTBAR_SLOTS);
  }

  /** Puts a block in the selected slot (from the inventory). */
  assign(block: BlockId): void {
    this.slots[this.selectedIndex] = block;
    this.renderSlot(this.selectedIndex);
    this.onChange?.();
  }

  /** Selects the slot already holding `block`, or puts it in the current
   * one — what a middle-click "pick block" does. */
  pick(block: BlockId): void {
    if (!INVENTORY_BLOCKS.includes(block)) return;
    const existing = this.slots.indexOf(block);
    if (existing >= 0) this.select(existing);
    else this.assign(block);
  }

  private applySelectionStyle(): void {
    this.elements.forEach((slot, i) => {
      slot.classList.toggle("selected", i === this.selectedIndex);
    });
  }

  get selectedBlock(): BlockId {
    return this.slots[this.selectedIndex] ?? PLACEABLE_BLOCKS[0] ?? 1;
  }

  get selectedSlot(): number {
    return this.selectedIndex;
  }

  get contents(): readonly BlockId[] {
    return this.slots;
  }
}
