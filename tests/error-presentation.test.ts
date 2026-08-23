import { describe, expect, it } from "vitest";
import { I18n } from "../src/i18n";
import {
  presentKnownError,
  presentKnownFileError,
  presentKnownPluginBundleError,
} from "../src/i18n/error-presentation";

function zh(): (key: string, params?: Record<string, string | number>) => string {
  const i18n = new I18n("zh-cn");
  return i18n.t.bind(i18n);
}

function en(): (key: string, params?: Record<string, string | number>) => string {
  const i18n = new I18n("en");
  return i18n.t.bind(i18n);
}

describe("known plugin bundle error presentation", () => {
  it("presents known identity errors in the current language", () => {
    expect(presentKnownPluginBundleError(
      "Selected plugin identity is ambiguous: dataview",
      zh(),
    )).toBe("插件身份不明确：dataview（多个目录声明了同一插件）");
    expect(presentKnownPluginBundleError(
      "Selected plugin manifest identity changed within directory: calendar",
      zh(),
    )).toBe("插件本机与云端的身份不一致：calendar");
    expect(presentKnownPluginBundleError(
      "Selected plugin manifest identity is invalid: calendar",
      zh(),
    )).toBe("插件清单中的身份字段无效：calendar");
  });

  it("keeps retired restore-source errors unmapped in every language", () => {
    expect(presentKnownPluginBundleError(
      "Selected plugin restore mixes legacy and generation sources: calendar",
      zh(),
    )).toBeNull();
    expect(presentKnownPluginBundleError(
      "Selected plugin restore spans several generation authorities: calendar",
      en(),
    )).toBeNull();
  });

  it("presents known manifest and bundle errors in the current language", () => {
    expect(presentKnownPluginBundleError(
      "Selected plugin manifest is unreadable: calendar",
      zh(),
    )).toBe("无法读取插件清单（manifest.json）：calendar");
    expect(presentKnownPluginBundleError(
      "Selected plugin manifest version is missing or invalid: calendar",
      zh(),
    )).toBe("插件清单中的版本字段缺失或无效：calendar");
    expect(presentKnownPluginBundleError(
      "Selected plugin minimum app version is invalid: calendar",
      zh(),
    )).toBe("插件清单中的最低版本字段无效：calendar");
    expect(presentKnownPluginBundleError(
      "Selected plugin bundle is incomplete locally: calendar",
      zh(),
    )).toBe("插件文件不完整（本机缺少文件）：calendar");
    expect(presentKnownPluginBundleError(
      "Selected plugin bundle is incomplete remotely: calendar",
      zh(),
    )).toBe("插件文件不完整（云端缺少文件）：calendar");
    expect(presentKnownPluginBundleError(
      "Selected plugin upload would downgrade remote bundle: calendar",
      zh(),
    )).toBe("本机插件版本低于云端，为避免回退未上传：calendar");
    expect(presentKnownPluginBundleError(
      "Selected plugin manifest download failed: calendar",
      zh(),
    )).toBe("无法下载插件清单：calendar");
    expect(presentKnownPluginBundleError(
      "Selected plugin local target changed: calendar",
      zh(),
    )).toBe("插件文件在上传前发生了变化：calendar");
  });

  it("presents every incompatibility kind with its own message", () => {
    expect(presentKnownPluginBundleError(
      "Selected plugin bundle is incompatible (downgrade): calendar",
      zh(),
    )).toBe("插件版本会回退，与本机不兼容：calendar");
    expect(presentKnownPluginBundleError(
      "Selected plugin bundle is incompatible (desktop-only): calendar",
      zh(),
    )).toBe("该插件仅支持桌面端：calendar");
    expect(presentKnownPluginBundleError(
      "Selected plugin bundle is incompatible (minimum-app-version): calendar",
      zh(),
    )).toBe("插件要求更高的 Obsidian 版本：calendar");
  });

  it("returns the raw message for English users (identical to today)", () => {
    const message = "Selected plugin identity is ambiguous: dataview";
    expect(presentKnownPluginBundleError(message, en())).toBe(message);
    const incompatible = "Selected plugin bundle is incompatible (downgrade): calendar";
    expect(presentKnownPluginBundleError(incompatible, en())).toBe(incompatible);
  });

  it("falls back to null for unknown messages and malformed incompatible suffixes", () => {
    expect(presentKnownPluginBundleError(
      "Some internal statement: x",
      zh(),
    )).toBeNull();
    expect(presentKnownPluginBundleError(
      "Selected plugin bundle is incompatible (unknown-kind): calendar",
      zh(),
    )).toBeNull();
    expect(presentKnownPluginBundleError(
      "Selected plugin bundle is incompatible (downgrade",
      zh(),
    )).toBeNull();
  });

  it("trims the extracted plugin id and keeps whitespace-safe tails", () => {
    expect(presentKnownPluginBundleError(
      "Selected plugin identity is ambiguous:  calendar ",
      en(),
    )).toBe("Selected plugin identity is ambiguous: calendar");
  });

  it("presents known file-operation errors in Chinese without parameters", () => {
    expect(presentKnownFileError(
      "Local file move read-back failed: a.md -> b.md",
      zh(),
      "zh-cn",
    )).toBe("无法确认本机文件移动结果");
    expect(presentKnownFileError(
      "Downloaded SHA-256 mismatch: notes/x.md",
      zh(),
      "zh-cn",
    )).toBe("下载文件校验不一致（SHA-256）");
    expect(presentKnownFileError(
      "Remote folder delete read-back failed: folder",
      zh(),
      "zh-cn",
    )).toBe("无法确认云端文件夹删除结果");
    expect(presentKnownFileError(
      "Recovery verification failed: notes/x.md",
      zh(),
      "zh-cn",
    )).toBe("恢复核验失败");
  });

  it("matches the most specific row for overlapping catalog prefixes", () => {
    expect(presentKnownFileError(
      "Remote plugin catalog member has no version: a/b.json",
      zh(),
      "zh-cn",
    )).toBe("云端插件清单条目缺少版本");
    expect(presentKnownFileError(
      "Remote plugin catalog field-x is invalid",
      zh(),
      "zh-cn",
    )).toBe("云端插件清单字段无效");
  });

  it("presents refined catalog rows for enumerable catalog failures", () => {
    expect(presentKnownFileError(
      "Remote plugin catalog scope is invalid",
      zh(),
      "zh-cn",
    )).toBe("云端插件清单范围无效");
    expect(presentKnownFileError(
      "Remote plugin catalog item belongs to another drive",
      zh(),
      "zh-cn",
    )).toBe("云端插件清单条目归属其他驱动器");
    expect(presentKnownFileError(
      "Remote plugin catalog scope changed during refresh",
      zh(),
      "zh-cn",
    )).toBe("刷新期间云端插件清单范围已变化");
  });

  it("presents internal invariant failures with a neutral Chinese summary", () => {
    expect(presentKnownFileError(
      "V2 folder receipt is incomplete: notes",
      zh(),
      "zh-cn",
    )).toBe("同步内部状态异常，本轮未完成该操作；原始详情保留在诊断日志");
    expect(presentKnownFileError(
      "Manual mutation receipt no longer matches: op-1",
      zh(),
      "zh-cn",
    )).toBe("同步内部状态异常，本轮未完成该操作；原始详情保留在诊断日志");
  });

  it("passes file and internal errors through as raw English for en users", () => {
    const fileMessage = "Local file move read-back failed: a.md -> b.md";
    expect(presentKnownFileError(fileMessage, en(), "en")).toBeNull();
    const internalMessage = "V2 folder receipt is incomplete: notes";
    expect(presentKnownFileError(internalMessage, en(), "en")).toBeNull();
  });

  it("routes known plugin errors first through the single entry point", () => {
    expect(presentKnownError(
      "Selected plugin identity is ambiguous: dataview",
      zh(),
      "zh-cn",
    )).toBe("插件身份不明确：dataview（多个目录声明了同一插件）");
    expect(presentKnownError(
      "Local folder move read-back failed: a -> b",
      zh(),
      "zh-cn",
    )).toBe("无法确认本机文件夹移动结果");
    expect(presentKnownError(
      "Unhandled sync action type: 42",
      zh(),
      "zh-cn",
    )).toBe("同步内部状态异常，本轮未完成该操作；原始详情保留在诊断日志");
    expect(presentKnownError(
      "Some internal statement: x",
      zh(),
      "zh-cn",
    )).toBeNull();
  });
});