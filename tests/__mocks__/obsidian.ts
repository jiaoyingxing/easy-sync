/**
 * Minimal Obsidian API mock for unit testing.
 * Only exports what the sync module imports at runtime.
 */

import { vi } from "vitest";

// Vault mock — returned by app.vault
export interface Vault {
  adapter: DataAdapter;
  getFiles(): TFile[];
  getAllLoadedFiles?(): TAbstractFile[];
  getName(): string;
}

// Minimal DataAdapter
export interface DataAdapter {
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  appendBinary(path: string, data: ArrayBuffer): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  exists(path: string, sensitive?: boolean): Promise<boolean>;
  stat(path: string): Promise<FileStats | null>;
}

export class TAbstractFile {
  path: string;

  constructor(path = "") {
    this.path = path;
  }
}

// Minimal TFile / TFolder
export class TFile extends TAbstractFile {}

export class TFolder extends TAbstractFile {}

// FileStats
export interface FileStats {
  size: number;
  mtime?: number;
}

// Platform — static platform detection (desktop defaults for tests)
export const Platform = {
  isMobile: false,
  isDesktop: true,
};

export const requireApiVersion = vi.fn((_version: string) => true);

// Notice — constructor shows a notification
export class Notice {
  noticeEl = {
    classList: {
      add: (..._tokens: string[]) => undefined,
      remove: (..._tokens: string[]) => undefined,
    },
  } as unknown as HTMLElement;
  messageEl = this.noticeEl;
  hidden = false;

  constructor(_message: string | DocumentFragment, _duration?: number) {}
  setMessage(_message: string | DocumentFragment): this { return this; }
  hide(): void { this.hidden = true; }
}

export class ProgressBarComponent {
  static instances: ProgressBarComponent[] = [];
  private value = 0;

  constructor(readonly containerEl: HTMLElement) {
    ProgressBarComponent.instances.push(this);
  }

  getValue(): number { return this.value; }
  setValue(value: number): this {
    this.value = value;
    return this;
  }
}

/** Minimal DOM element stub for UI unit tests (no jsdom installed).
 *  Supports the handful of DOM operations EasySync modal code uses. */
export function createMockElement(): HTMLElement {
  const element: Record<string, unknown> = {
    classList: { add: () => undefined, remove: () => undefined },
    children: [] as unknown[],
    innerHTML: "",
    textContent: "",
  };
  element.empty = () => {
    element.innerHTML = "";
    element.children = [];
    return element;
  };
  element.addClass = (..._tokens: string[]) => element;
  element.removeClass = (..._tokens: string[]) => element;
  element.toggleClass = (_token: string, _on?: boolean) => element;
  element.setAttribute = (_name: string, _value: string) => element;
  element.setText = (_value: string | DocumentFragment) => element;
  element.createDiv = () => createMockElement();
  element.createSpan = () => createMockElement();
  element.createEl = () => createMockElement();
  element.appendChild = (_child: unknown) => element;
  element.closest = () => null;
  element.querySelector = () => null;
  element.isConnected = false;
  return element as unknown as HTMLElement;
}

export class Modal {
  contentEl: HTMLElement = createMockElement();
  containerEl: HTMLElement = createMockElement();
  modalEl: HTMLElement = createMockElement();

  constructor(_app?: App) {}
  setTitle(_title: string): void {}
  open(): void {}
  close(): void {}
}

export abstract class FuzzySuggestModal<T> extends Modal {
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
  setPlaceholder(_placeholder: string): this { return this; }
  setInstructions(_instructions: Array<{ command: string; purpose: string }>): this { return this; }
}

// requestUrl — used by OneDrive client
export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

export function requestUrl(_opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
}): Promise<RequestUrlResponse> {
  return Promise.resolve({
    status: 200,
    headers: {},
    json: null,
  });
}

export const activeWindow = {
  setTimeout: (handler: () => unknown, timeout?: number) =>
    setTimeout(handler, timeout) as unknown as number,
  clearTimeout: (handle: number) => {
    clearTimeout(handle);
  },
  setInterval: (handler: () => unknown, timeout?: number) =>
    setInterval(handler, timeout) as unknown as number,
  clearInterval: (handle: number) => {
    clearInterval(handle);
  },
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 16) as unknown as number,
  cancelAnimationFrame: (handle: number) => {
    clearTimeout(handle);
  },
} as unknown as Window;

if (typeof (globalThis as { window?: Window }).window === "undefined") {
  (globalThis as { window?: Window }).window = activeWindow;
}

// Plugin base class
export class Plugin {
  app: App;
  manifest: { id: string; dir?: string };

  constructor(app?: App, manifest?: { id: string; dir?: string }) {
    this.app = app ?? {
      vault: {
        adapter: {} as DataAdapter,
        getFiles: () => [],
        getName: () => "testVault",
      },
      workspace: {
        getLeavesOfType: () => [],
        getLeftLeaf: () => null,
        revealLeaf: () => undefined,
      } as unknown as Workspace,
    };
    this.manifest = manifest ?? { id: "easy-sync", dir: ".obsidian/plugins/easy-sync" };
  }

  loadData(): Promise<unknown> {
    return Promise.resolve({});
  }

  saveData(_data: unknown): Promise<void> {
    return Promise.resolve();
  }

  addRibbonIcon(_icon: string, _title: string, _callback: () => void): HTMLElement {
    return document.createElement("div");
  }

  addStatusBarItem(): HTMLElement {
    return document.createElement("div");
  }

  addCommand(_command: unknown): void {}

  addSettingTab(_tab: unknown): void {}

  registerView(_type: string, _creator: (leaf: WorkspaceLeaf) => unknown): void {}

  registerEvent(_eventRef: unknown): void {}

  registerObsidianProtocolHandler(_action: string, _handler: (params: unknown) => void): void {}
}

export class PluginSettingTab {
  containerEl: HTMLElement = document.createElement("div");

  constructor(public app: App, public plugin: Plugin) {}

  display(): void {}
  hide(): void {}
}

export class ButtonComponent {
  buttonEl = {
    classList: { add: () => undefined },
    addClass: () => undefined,
    setAttribute: () => undefined,
  } as unknown as HTMLButtonElement;

  constructor(_containerEl: HTMLElement) {}
  setButtonText(_text: string): this { return this; }
  setIcon(_icon: string): this { return this; }
  setTooltip(_tooltip: string): this { return this; }
  setDisabled(_disabled: boolean): this { return this; }
  setWarning(): this { return this; }
  // NOTE: `setDestructive` exists only on Obsidian 1.13.0+ hosts. This mock
  // exposes it unconditionally, so any test that calls it directly would pass
  // here but throw on 1.11.4–1.12.x. Production code must go through
  // `applyDestructiveButton` (src/ui/destructive-button.ts), which gates on
  // the runtime capability and falls back to `mod-warning` — never call
  // `button.setDestructive()` directly.
  setDestructive(): this { return this; }
  setCta(): this { return this; }
  onClick(_callback: () => void | Promise<void>): this { return this; }
}

export class ToggleComponent {
  constructor(_containerEl: HTMLElement) {}
  setValue(_value: boolean): this { return this; }
  onChange(_callback: (value: boolean) => void | Promise<void>): this { return this; }
}

export class ExtraButtonComponent {
  extraSettingsEl: HTMLElement = createMockElement();

  constructor(_containerEl: HTMLElement) {}
  setIcon(_icon: string): this { return this; }
  setTooltip(_tooltip: string): this { return this; }
  onClick(_callback: () => void | Promise<void>): this { return this; }
}

export class SliderComponent {
  static instances: SliderComponent[] = [];
  sliderEl = {
    closest: (_selector: string): HTMLElement | null => null,
  } as unknown as HTMLInputElement;
  private onChangeCallback: ((value: number) => void | Promise<void>) | null = null;
  value = 0;

  constructor(_containerEl: HTMLElement) {
    SliderComponent.instances.push(this);
  }
  setLimits(_min: number, _max: number, _step: number): this { return this; }
  setValue(value: number): this {
    this.value = value;
    return this;
  }
  onChange(callback: (value: number) => void | Promise<void>): this {
    this.onChangeCallback = callback;
    return this;
  }
  /** Test helper: invoke the registered onChange callback. */
  triggerChange(value: number): void | Promise<void> {
    if (!this.onChangeCallback) {
      throw new Error("SliderComponent.onChange was never registered");
    }
    return this.onChangeCallback(value);
  }
}

export class DropdownComponent {
  selectEl = {} as HTMLSelectElement;

  constructor(_containerEl: HTMLElement) {}
  addOption(_value: string, _display: string): this { return this; }
  addOptions(_options: Record<string, string>): this { return this; }
  setValue(_value: string): this { return this; }
  setDisabled(_disabled: boolean): this { return this; }
  onChange(_callback: (value: string) => void | Promise<void>): this { return this; }
}

export class Setting {
  descEl: HTMLElement = createMockElement();

  constructor(_containerEl: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addButton(callback: (component: ButtonComponent) => void): this {
    callback(new ButtonComponent({} as HTMLElement));
    return this;
  }
  addExtraButton(callback: (component: ExtraButtonComponent) => void): this {
    callback(new ExtraButtonComponent({} as HTMLElement));
    return this;
  }
  addToggle(callback: (component: ToggleComponent) => void): this {
    callback(new ToggleComponent({} as HTMLElement));
    return this;
  }
  addSlider(callback: (component: SliderComponent) => void): this {
    callback(new SliderComponent({} as HTMLElement));
    return this;
  }
  addDropdown(callback: (component: DropdownComponent) => void): this {
    callback(new DropdownComponent({} as HTMLElement));
    return this;
  }
}

export class SettingGroup {
  constructor(_containerEl: HTMLElement) {}
  setHeading(_text: string): this { return this; }
  addSetting(callback: (setting: Setting) => void): this {
    callback(new Setting({} as HTMLElement));
    return this;
  }
}

export interface App {
  vault: Vault;
  workspace: Workspace;
}

export interface Workspace {
  getLeavesOfType(_type: string): unknown[];
  getLeftLeaf?(_split: boolean): WorkspaceLeaf | null;
  revealLeaf?(_leaf: WorkspaceLeaf): void;
}

export class WorkspaceLeaf {}

export class ItemView {
  contentEl: HTMLElement = document.createElement("div");

  constructor(_leaf: WorkspaceLeaf) {}
}

export function setIcon(_el: HTMLElement, _icon: string): void {}

export function setTooltip(_el: HTMLElement, _tooltip: string): void {}
