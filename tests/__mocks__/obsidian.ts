/**
 * Minimal Obsidian API mock for unit testing.
 * Only exports what the sync module imports at runtime.
 */

// Vault mock — returned by app.vault
export interface Vault {
  adapter: DataAdapter;
  getFiles(): TFile[];
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

// Minimal TFile
export class TFile {
  path: string;

  constructor(path = "") {
    this.path = path;
  }
}

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

// Notice — constructor shows a notification
export class Notice {
  constructor(_message: string, _duration?: number) {}
  static setMessage(_message: string): void {}
}

export class Modal {
  contentEl: HTMLElement = document.createElement("div");

  constructor(_app?: App) {}
  setTitle(_title: string): void {}
  open(): void {}
  close(): void {}
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
  buttonEl = { classList: { add: () => undefined } } as unknown as HTMLButtonElement;

  constructor(_containerEl: HTMLElement) {}
  setButtonText(_text: string): this { return this; }
  setDisabled(_disabled: boolean): this { return this; }
  setWarning(): this { return this; }
  setDestructive(): this { return this; }
  setCta(): this { return this; }
  onClick(_callback: () => void | Promise<void>): this { return this; }
}

export class ToggleComponent {
  constructor(_containerEl: HTMLElement) {}
  setValue(_value: boolean): this { return this; }
  onChange(_callback: (value: boolean) => void | Promise<void>): this { return this; }
}

export class SliderComponent {
  sliderEl = {} as HTMLInputElement;

  constructor(_containerEl: HTMLElement) {}
  setLimits(_min: number, _max: number, _step: number): this { return this; }
  setValue(_value: number): this { return this; }
  onChange(_callback: (value: number) => void | Promise<void>): this { return this; }
}

export class Setting {
  constructor(_containerEl: HTMLElement) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addButton(callback: (component: ButtonComponent) => void): this {
    callback(new ButtonComponent({} as HTMLElement));
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
