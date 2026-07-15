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

export class ButtonComponent {
  constructor(_containerEl: HTMLElement) {}
  setButtonText(_text: string): this { return this; }
  setDisabled(_disabled: boolean): this { return this; }
  setWarning(): this { return this; }
  setCta(): this { return this; }
  onClick(_callback: () => void | Promise<void>): this { return this; }
}

export function setIcon(_el: HTMLElement, _icon: string): void {}

export function setTooltip(_el: HTMLElement, _tooltip: string): void {}
