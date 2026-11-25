import { describe, expect, it, vi } from "vitest";
import { ONEDRIVE_CAPABILITIES } from "../src/onedrive/capabilities";
import { OneDriveClient } from "../src/onedrive/client";

/**
 * B1 能力合同门：钉住 OneDrive 声明的 14 位能力（名字、取值、冻结）与
 * `SyncProvider.capabilities` 的 getter 形态。表里的名字与取值是本测试
 * 自带的独立字面量——**不从源码常量反推**，否则源码漂移会被同源断言掩盖。
 * 三个负例复用本地 `expectCapabilities`，证明检查函数不是恒真。
 */
const EXPECTED_CAPABILITY_NAMES = [
  "stableIdentity",
  "conditionalCreate",
  "conditionalUpdate",
  "conditionalDelete",
  "serverSideMove",
  "deltaCursor",
  "folderEntity",
  "contentChecksum",
  "contentVersionToken",
  "versionHistory",
  "recycleBin",
  "rangeDownload",
  "resumableUpload",
  "maxSinglePutBytes",
] as const;

const EXPECTED_CAPABILITY_VALUES = {
  stableIdentity: true,
  conditionalCreate: true,
  conditionalUpdate: true,
  conditionalDelete: true,
  serverSideMove: true,
  deltaCursor: true,
  folderEntity: true,
  contentChecksum: true,
  contentVersionToken: true,
  versionHistory: true,
  recycleBin: true,
  rangeDownload: true,
  resumableUpload: true,
  maxSinglePutBytes: 4_194_304,
} as const;

type CapabilityName = (typeof EXPECTED_CAPABILITY_NAMES)[number];

/** 键集＋逐项值＋逐项类型三重比较；正例与机制负例共用同一套断言。 */
function expectCapabilities(candidate: object): void {
  const record = candidate as Readonly<Record<string, unknown>>;
  expect(Object.keys(record).sort()).toEqual(
    [...EXPECTED_CAPABILITY_NAMES].sort(),
  );
  for (const name of EXPECTED_CAPABILITY_NAMES) {
    expect(record[name]).toBe(EXPECTED_CAPABILITY_VALUES[name]);
    expect(typeof record[name]).toBe(
      typeof EXPECTED_CAPABILITY_VALUES[name],
    );
  }
}

describe("ProviderCapabilities contract", () => {
  it("declares exactly the 14 capability slots", () => {
    const declaredNames = Object.keys(ONEDRIVE_CAPABILITIES).sort();
    expect(declaredNames).toEqual([...EXPECTED_CAPABILITY_NAMES].sort());
    expect(declaredNames).toHaveLength(14);
    // 正例控制：同一断言函数对真实声明不抛错，负例的 throw 才说明机制有效。
    expect(() => expectCapabilities(ONEDRIVE_CAPABILITIES)).not.toThrow();
  });

  it("pins every OneDrive capability value", () => {
    for (const name of EXPECTED_CAPABILITY_NAMES) {
      expect(ONEDRIVE_CAPABILITIES[name]).toBe(EXPECTED_CAPABILITY_VALUES[name]);
      if (name === "maxSinglePutBytes") {
        expect(typeof ONEDRIVE_CAPABILITIES[name]).toBe("number");
        expect(ONEDRIVE_CAPABILITIES[name]).toBe(4 * 1024 * 1024);
      } else {
        expect(typeof ONEDRIVE_CAPABILITIES[name]).toBe("boolean");
      }
    }
  });

  it("keeps the declaration deeply equal to the pinned table", () => {
    expect(ONEDRIVE_CAPABILITIES).toEqual(EXPECTED_CAPABILITY_VALUES);
  });

  it("keeps the declaration frozen", () => {
    expect(Object.isFrozen(ONEDRIVE_CAPABILITIES)).toBe(true);
    expect(() => {
      (ONEDRIVE_CAPABILITIES as { rangeDownload: boolean }).rangeDownload = false;
    }).toThrow(TypeError);
    expect(ONEDRIVE_CAPABILITIES.rangeDownload).toBe(true);
  });

  it("serves capabilities from a getter without I/O", () => {
    const getToken = vi.fn(async (): Promise<string> => {
      throw new Error("token read");
    });
    const client = new OneDriveClient(getToken);
    expect(client.capabilities).toBe(ONEDRIVE_CAPABILITIES);
    expect(getToken).not.toHaveBeenCalled();
    expect(typeof client.capabilities).toBe("object");
    // getter 在原型上：不新增实例字段，JSON.stringify(client) 形状不变。
    expect(Object.prototype.hasOwnProperty.call(client, "capabilities")).toBe(
      false,
    );
  });

  it("fails on a missing slot (mechanism proof)", () => {
    const missing = { ...ONEDRIVE_CAPABILITIES } as Record<string, unknown>;
    delete missing.rangeDownload;
    expect(() => expectCapabilities(missing)).toThrow();
  });

  it("fails on an extra slot (mechanism proof)", () => {
    const extra = {
      ...ONEDRIVE_CAPABILITIES,
      batchMetadata: true,
    };
    expect(() => expectCapabilities(extra)).toThrow();
  });

  it("fails on a changed value (mechanism proof)", () => {
    const changedNumber = {
      ...ONEDRIVE_CAPABILITIES,
      maxSinglePutBytes: 4_194_305,
    };
    expect(() => expectCapabilities(changedNumber)).toThrow();
    const changedBoolean = {
      ...ONEDRIVE_CAPABILITIES,
      rangeDownload: false,
    };
    expect(() => expectCapabilities(changedBoolean)).toThrow();
  });
});
