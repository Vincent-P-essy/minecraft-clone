import { DISCOVERIES, type Journal } from "../game/discoveries";
import { type Bag, canCraft, type Recipe, RECIPES } from "../game/items";
import type { Translator } from "../i18n";
import { BLOCKS, type BlockId, INVENTORY_BLOCKS } from "../world/blocks";
import { renderBlockIcon } from "./block-icon";

export type InventoryTab = "blocks" | "craft" | "journal";

export interface InventoryState {
  /** null in Creative mode: every block, unlimited. */
  readonly bag: Bag | null;
  readonly journal: Journal;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The inventory panel. In Creative it's every block in the game; in
 * Adventure it's what's in the bag, plus a tab of recipes. Both modes get
 * the discovery journal. Choosing a block drops it into the selected
 * hotbar slot. */
export class Inventory {
  private readonly panel: HTMLDivElement;
  private readonly tabs: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly atlas: HTMLCanvasElement;
  private readonly t: Translator;
  private readonly icons = new Map<BlockId, HTMLCanvasElement>();
  private open = false;
  private tab: InventoryTab = "blocks";
  private state: InventoryState | null = null;
  onChoose: ((block: BlockId) => void) | undefined;
  onCraft: ((recipe: Recipe) => void) | undefined;
  onClose: (() => void) | undefined;

  constructor(parent: HTMLElement, atlas: HTMLCanvasElement, t: Translator) {
    this.atlas = atlas;
    this.t = t;
    this.panel = el("div", "panel hidden");
    this.panel.id = "inventory";

    const header = el("div", "panel-header");
    this.tabs = el("div", "panel-tabs");
    const close = el("button", "icon-button", "✕");
    close.type = "button";
    close.setAttribute("aria-label", t("close"));
    close.addEventListener("click", () => {
      this.onClose?.();
    });
    header.append(this.tabs, close);

    this.body = el("div", "panel-body");
    this.panel.append(header, this.body);
    // Clicks on the panel must not fall through to the game canvas.
    this.panel.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
    });
    parent.appendChild(this.panel);
  }

  private icon(block: BlockId): HTMLCanvasElement {
    let source = this.icons.get(block);
    if (!source) {
      source = renderBlockIcon(this.atlas, block, 64);
      this.icons.set(block, source);
    }
    // Each use needs its own canvas; copy the cached render.
    const copy = document.createElement("canvas");
    copy.width = source.width;
    copy.height = source.height;
    copy.getContext("2d")?.drawImage(source, 0, 0);
    return copy;
  }

  /** Shows the panel for the current mode's state. */
  show(state: InventoryState, tab?: InventoryTab): void {
    this.state = state;
    if (tab) this.tab = tab;
    if (this.tab === "craft" && !state.bag) this.tab = "blocks";
    this.open = true;
    this.panel.classList.remove("hidden");
    this.render();
  }

  hide(): void {
    this.open = false;
    this.panel.classList.add("hidden");
  }

  /** Redraws the open panel (after crafting changes the bag). */
  refresh(): void {
    if (this.open) this.render();
  }

  private render(): void {
    const state = this.state;
    if (!state) return;
    const names: [InventoryTab, string][] = [["blocks", this.t("tabBlocks")]];
    if (state.bag) names.push(["craft", this.t("tabCraft")]);
    names.push(["journal", this.t("tabJournal")]);
    this.tabs.replaceChildren(
      ...names.map(([id, label]) => {
        const button = el("button", id === this.tab ? "tab active" : "tab", label);
        button.type = "button";
        button.dataset.tab = id;
        button.addEventListener("click", () => {
          this.tab = id;
          this.render();
        });
        return button;
      }),
    );

    if (this.tab === "blocks") this.renderBlocks(state);
    else if (this.tab === "craft" && state.bag) this.renderRecipes(state.bag);
    else this.renderJournal(state.journal);
  }

  private renderBlocks(state: InventoryState): void {
    const blocks = state.bag ? state.bag.owned() : INVENTORY_BLOCKS;
    if (blocks.length === 0) {
      this.body.replaceChildren(el("p", "panel-hint", this.t("bagEmpty")));
      return;
    }
    const grid = el("div", "inventory-grid");
    for (const block of blocks) {
      const name = this.t.block(BLOCKS[block].name);
      const cell = el("button", "inventory-cell");
      cell.type = "button";
      cell.title = name;
      cell.setAttribute("aria-label", name);
      cell.dataset.block = block.toString();
      cell.appendChild(this.icon(block));
      if (state.bag) cell.appendChild(el("span", "cell-count", state.bag.count(block).toString()));
      cell.addEventListener("click", () => {
        this.onChoose?.(block);
      });
      grid.appendChild(cell);
    }
    this.body.replaceChildren(grid, el("p", "panel-hint", this.t("inventoryHint")));
  }

  private renderRecipes(bag: Bag): void {
    const list = el("div", "recipe-list");
    for (const recipe of RECIPES) {
      const row = el("button", "recipe");
      row.type = "button";
      row.dataset.recipe = recipe.id;
      row.disabled = !canCraft(bag, recipe);

      const needs = el("span", "recipe-side");
      for (const [block, amount] of recipe.needs) {
        const part = el("span", "recipe-item");
        part.title = this.t.block(BLOCKS[block].name);
        part.append(this.icon(block), el("span", "cell-count", `${bag.count(block)}/${amount}`));
        part.classList.toggle("short", bag.count(block) < amount);
        needs.appendChild(part);
      }
      const makes = el("span", "recipe-item");
      makes.title = this.t.block(BLOCKS[recipe.output].name);
      makes.append(this.icon(recipe.output), el("span", "cell-count", `×${recipe.amount}`));

      row.append(needs, el("span", "recipe-arrow", "→"), makes);
      row.addEventListener("click", () => {
        this.onCraft?.(recipe);
      });
      list.appendChild(row);
    }
    this.body.replaceChildren(list, el("p", "panel-hint", this.t("craftHint")));
  }

  private renderJournal(journal: Journal): void {
    const list = el("div", "journal-list");
    for (const discovery of DISCOVERIES) {
      const found = journal.has(discovery.id);
      const row = el("div", found ? "journal-entry found" : "journal-entry");
      row.dataset.discovery = discovery.id;
      row.append(
        el("span", "journal-icon", found ? discovery.icon : "？"),
        el("span", "journal-name", found ? this.t.discovery(discovery.id) : "· · ·"),
      );
      list.appendChild(row);
    }
    this.body.replaceChildren(
      el(
        "p",
        "journal-progress",
        this.t("journalProgress", { found: journal.count, total: journal.total }),
      ),
      list,
    );
  }

  get isOpen(): boolean {
    return this.open;
  }
}
