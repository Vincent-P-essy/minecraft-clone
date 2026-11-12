import { GAME_NAME, GAME_VERSION } from "../branding";
import { type LanguageSetting, type TextKey, type Translator } from "../i18n";
import { QUALITY_LEVELS, type QualityLevel } from "../render/renderer";
import { FOV_RANGE, type SettingsStore, VIEW_DISTANCE_RANGE } from "../settings";

/** Turns whatever the player typed into a world seed: a plain number is
 * used as-is, anything else is hashed, and nothing at all rolls a random
 * one. Seeds stay within 31 bits so they survive a round trip through
 * the URL. */
export function seedFromText(text: string, random: () => number = Math.random): number {
  const trimmed = text.trim();
  if (trimmed === "") return Math.floor(random() * 0x7fffffff);
  if (/^-?\d{1,10}$/.test(trimmed)) return Math.abs(Number.parseInt(trimmed, 10)) % 0x7fffffff;
  let hash = 2166136261;
  for (let i = 0; i < trimmed.length; i++) {
    hash = Math.imul(hash ^ trimmed.charCodeAt(i), 16777619);
  }
  return (hash >>> 0) % 0x7fffffff;
}

export interface MenuHandlers {
  /** Load a different world (reloads the page with that seed). */
  readonly onOpenWorld: (seed: number) => void;
  /** Forget every edit made to the current world. */
  readonly onResetWorld: () => void;
  readonly onClick: () => void;
  readonly canUsePost: boolean;
  readonly seed: number;
  readonly touch: boolean;
  readonly t: Translator;
  /** The language setting changed: the page reloads to apply it. */
  readonly onLanguageChange: () => void;
}

type Screen = "main" | "settings" | "world";

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

/** The title / pause menu: play, settings, worlds. It fills in the static
 * shell from index.html (which already holds the play button, so the game
 * is startable before any of this runs). */
export class Menu {
  private readonly root: HTMLElement;
  private readonly settings: SettingsStore;
  private readonly handlers: MenuHandlers;
  private readonly screens = new Map<Screen, HTMLElement>();
  private readonly playButton: HTMLButtonElement | null;
  private readonly t: Translator;

  constructor(root: HTMLElement, settings: SettingsStore, handlers: MenuHandlers) {
    this.root = root;
    this.settings = settings;
    this.handlers = handlers;
    this.t = handlers.t;
    this.playButton = root.querySelector<HTMLButtonElement>("#play-button");

    const main = root.querySelector<HTMLElement>('[data-screen="main"]');
    if (main) {
      this.screens.set("main", main);
      const title = main.querySelector(".title");
      if (title) title.textContent = GAME_NAME;
      // Fill in the static shell's text in the player's language.
      for (const node of main.querySelectorAll<HTMLElement>("[data-i18n]")) {
        node.textContent = this.t(node.dataset.i18n as TextKey);
      }
      for (const node of main.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
        // Trusted, static markup from the string table (it carries <kbd>).
        node.innerHTML = this.t(node.dataset.i18nHtml as TextKey);
      }
      if (this.playButton) this.playButton.textContent = this.t("play");
      const version = main.querySelector(".version");
      if (version) {
        version.textContent = this.t("version", { version: GAME_VERSION, seed: handlers.seed });
      }
      main.querySelector("#settings-button")?.addEventListener("click", () => {
        this.show("settings");
      });
      main.querySelector("#world-button")?.addEventListener("click", () => {
        this.show("world");
      });
      main.querySelector("#fullscreen-button")?.addEventListener("click", () => {
        this.toggleFullscreen();
      });
    }
    this.screens.set("settings", this.buildSettings());
    this.screens.set("world", this.buildWorld());
    for (const [name, screen] of this.screens) {
      if (name !== "main") this.root.appendChild(screen);
    }
    this.root.addEventListener("click", (e) => {
      if (e.target instanceof HTMLElement && e.target.closest("button")) handlers.onClick();
    });
    this.show("main");
  }

  /** After the first start the big button resumes instead of starting. */
  markStarted(): void {
    if (this.playButton) this.playButton.textContent = this.t("resume");
  }

  show(screen: Screen): void {
    for (const [name, node] of this.screens) node.hidden = name !== screen;
  }

  private toggleFullscreen(): void {
    const doc = document;
    if (doc.fullscreenElement) {
      void doc.exitFullscreen();
      return;
    }
    const request = doc.documentElement.requestFullscreen.bind(doc.documentElement);
    request()
      .then(() => {
        // Phones play best sideways; desktops ignore this.
        const orientation = screen.orientation as ScreenOrientation & {
          lock?: (orientation: string) => Promise<void>;
        };
        return typeof orientation.lock === "function" ? orientation.lock("landscape") : undefined;
      })
      .catch(() => undefined);
  }

  private row(label: string, control: HTMLElement, value?: HTMLElement): HTMLElement {
    const row = el("label", "setting-row");
    const name = el("span", "setting-name", label);
    row.append(name, control);
    if (value) row.append(value);
    return row;
  }

  private slider(
    label: string,
    key: "viewDistance" | "fov" | "sensitivity" | "volume",
    min: number,
    max: number,
    step: number,
    format: (value: number) => string,
  ): HTMLElement {
    const input = el("input");
    input.type = "range";
    input.min = min.toString();
    input.max = max.toString();
    input.step = step.toString();
    input.value = this.settings.values[key].toString();
    const readout = el("span", "setting-value", format(this.settings.values[key]));
    input.addEventListener("input", () => {
      const value = Number(input.value);
      readout.textContent = format(value);
      this.settings.set(key, value);
    });
    return this.row(label, input, readout);
  }

  private toggle(
    label: string,
    key: "invertY" | "autoJump" | "viewBob" | "showStats",
  ): HTMLElement {
    const input = el("input");
    input.type = "checkbox";
    input.checked = this.settings.values[key];
    input.addEventListener("change", () => {
      this.settings.set(key, input.checked);
    });
    return this.row(label, input);
  }

  private buildSettings(): HTMLElement {
    const screen = el("div", "menu-screen");
    screen.dataset.screen = "settings";
    screen.append(el("h2", undefined, this.t("settings")));

    const quality = el("div", "segmented");
    const labels: Record<QualityLevel, string> = {
      low: this.t("qualityLow"),
      medium: this.t("qualityMedium"),
      high: this.t("qualityHigh"),
      ultra: this.t("qualityUltra"),
    };
    const buttons: HTMLButtonElement[] = [];
    const refresh = (): void => {
      buttons.forEach((button) => {
        button.classList.toggle("active", button.dataset.level === this.settings.values.quality);
      });
    };
    for (const level of QUALITY_LEVELS) {
      const button = el("button", undefined, labels[level]);
      button.type = "button";
      button.dataset.level = level;
      // Tiers that need an HDR render target are greyed out where the
      // device can't provide one.
      if (level !== "low" && !this.handlers.canUsePost) button.disabled = true;
      button.addEventListener("click", () => {
        this.settings.set("quality", level);
        refresh();
      });
      buttons.push(button);
      quality.appendChild(button);
    }
    refresh();
    const qualityRow = el("div", "setting-row");
    qualityRow.append(el("span", "setting-name", this.t("graphics")), quality);

    const list = el("div", "settings-list");
    const language = el("select");
    for (const [value, label] of [
      ["auto", this.t("languageAuto")],
      ["en", "English"],
      ["fr", "Français"],
    ] as const) {
      const option = el("option", undefined, label);
      option.value = value;
      option.selected = this.settings.values.language === value;
      language.appendChild(option);
    }
    language.addEventListener("change", () => {
      this.settings.set("language", language.value as LanguageSetting);
      this.handlers.onLanguageChange();
    });

    list.append(
      qualityRow,
      this.slider(
        this.t("viewDistance"),
        "viewDistance",
        VIEW_DISTANCE_RANGE.min,
        VIEW_DISTANCE_RANGE.max,
        1,
        (v) => this.t("chunks", { n: v }),
      ),
      this.slider(this.t("fov"), "fov", FOV_RANGE.min, FOV_RANGE.max, 1, (v) => `${v.toString()}°`),
      this.slider(this.t("sensitivity"), "sensitivity", 0.2, 3, 0.05, (v) => `${v.toFixed(2)}×`),
      this.slider(
        this.t("volume"),
        "volume",
        0,
        1,
        0.05,
        (v) => `${Math.round(v * 100).toString()}%`,
      ),
      this.toggle(this.t("invertY"), "invertY"),
      this.toggle(this.t("autoJump"), "autoJump"),
      this.toggle(this.t("viewBob"), "viewBob"),
      this.toggle(this.t("showStats"), "showStats"),
      this.row(this.t("language"), language),
    );
    screen.append(list, this.backButton());
    return screen;
  }

  private buildWorld(): HTMLElement {
    const screen = el("div", "menu-screen");
    screen.dataset.screen = "world";
    screen.append(el("h2", undefined, this.t("worlds")));
    screen.append(el("p", "panel-hint", this.t("worldsIntro", { seed: this.handlers.seed })));

    const form = el("form", "seed-form");
    const input = el("input");
    input.type = "text";
    input.placeholder = this.t("seedPlaceholder");
    input.maxLength = 40;
    input.setAttribute("aria-label", this.t("seedLabel"));
    const create = el("button", "btn primary", this.t("exploreWorld"));
    create.type = "submit";
    form.append(input, create);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      this.handlers.onOpenWorld(seedFromText(input.value));
    });

    const random = el("button", "btn", this.t("surpriseMe"));
    random.type = "button";
    random.addEventListener("click", () => {
      this.handlers.onOpenWorld(seedFromText(""));
    });

    const reset = el("button", "btn danger", this.t("resetWorld"));
    reset.type = "button";
    let armed = false;
    reset.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        reset.textContent = this.t("resetConfirm");
        setTimeout(() => {
          armed = false;
          reset.textContent = this.t("resetWorld");
        }, 4000);
        return;
      }
      this.handlers.onResetWorld();
    });

    screen.append(form, random, reset, this.backButton());
    return screen;
  }

  private backButton(): HTMLElement {
    const back = el("button", "btn", this.t("back"));
    back.type = "button";
    back.addEventListener("click", () => {
      this.show("main");
    });
    return back;
  }
}
