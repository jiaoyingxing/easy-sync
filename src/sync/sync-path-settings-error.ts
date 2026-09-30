export class SyncPathSettingsUpdateError extends Error {
  constructor(readonly code: "busy" | "recovery") {
    super(code);
    this.name = "SyncPathSettingsUpdateError";
  }
}
