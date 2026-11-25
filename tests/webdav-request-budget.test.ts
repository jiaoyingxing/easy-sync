import { describe, expect, it } from "vitest";
import { WebDavClient } from "../src/providers/webdav/webdav-client";
import { WebDavProvider } from "../src/providers/webdav/webdav-provider";
import {
  createWebDavColdStartHarness,
  WEBDAV_COLD_START_USER_PATH,
  WEBDAV_COLD_START_USER_TEXT,
} from "./helpers/webdav-cold-start-harness";
import {
  installWebDavProbeFixture,
  WEBDAV_TEST_ENDPOINT,
  WEBDAV_TEST_PASSWORD,
  WEBDAV_TEST_USERNAME,
} from "./helpers/webdav-probe-fixture";

const fixture = installWebDavProbeFixture({ rootPath: "/vault" });
const endpoint = `${WEBDAV_TEST_ENDPOINT}/vault`;
const credentials = {
  username: WEBDAV_TEST_USERNAME,
  password: WEBDAV_TEST_PASSWORD,
};

function makeClient(): WebDavClient {
  return new WebDavClient({ endpoint, credentials, transport: fixture.transport });
}

function seedTree(): void {
  fixture.fake.seedFile("/vault/root.md", "root");
  for (const folder of ["a", "b", "c"]) {
    fixture.fake.seedCollection(`/vault/${folder}`);
    for (let index = 0; index < 10; index += 1) {
      fixture.fake.seedFile(`/vault/${folder}/note-${index}.md`, `${folder}-${index}`);
    }
  }
}

function propfindDelta(client: WebDavClient, before: number): number {
  return (client.requestCountsByMethod.PROPFIND ?? 0) - before;
}

describe("WebDAV 请求计数与扫描重复度", () => {
  it("fullScan 每个集合只列一次，没有同轮重复 PROPFIND", async () => {
    fixture.fake.setProfiles(["strict"]);
    seedTree();
    const client = makeClient();
    await client.initialize();
    const provider = new WebDavProvider({ client });

    // 计数必须覆盖探针：探针与业务请求走同一个 transport 包装。
    expect(client.requestCount).toBe(fixture.fake.requests.length);

    const before = client.requestCountsByMethod.PROPFIND ?? 0;
    const items = await provider.fullScan("vault");
    const propfinds = propfindDelta(client, before);

    expect(items).toHaveLength(34);
    // 根 + a + b + c：每个集合恰好一次 Depth 1 列表。
    expect(propfinds).toBe(4);
    expect(client.requestCount).toBe(fixture.fake.requests.length);
  });

  it("跨轮不假设列表可缓存：第二轮重新列出每个集合", async () => {
    fixture.fake.setProfiles(["strict"]);
    seedTree();
    const client = makeClient();
    await client.initialize();
    const provider = new WebDavProvider({ client });

    const firstBefore = client.requestCountsByMethod.PROPFIND ?? 0;
    await provider.fullScan("vault");
    const first = propfindDelta(client, firstBefore);

    const secondBefore = client.requestCountsByMethod.PROPFIND ?? 0;
    await provider.fullScan("vault");
    const second = propfindDelta(client, secondBefore);

    // 标准 WebDAV 没有集合级 ETag／delta；跨轮缓存无法证明未变，宁可重列。
    expect(first).toBe(4);
    expect(second).toBe(4);
  });

  it("真实引擎稳态轮每个集合只列一次 Depth 1（同轮短缓存暂不需要）", async () => {
    const harness = await createWebDavColdStartHarness({
      localFiles: {
        [WEBDAV_COLD_START_USER_PATH]: WEBDAV_COLD_START_USER_TEXT,
        "docs/a.md": "alpha",
      },
      localFolders: ["docs"],
    });
    try {
      expect((await harness.runRound("manual")).message)
        .toBe("result.pausedForReview");
      await harness.confirmRound(harness.state.planReviewAuthorization!);

      const before = harness.fake.requests.length;
      const steady = await harness.runRound("manual");
      expect(steady.errors).toBe(0);
      const propfinds = harness.fake.requests
        .slice(before)
        .filter((request) => request.method === "PROPFIND"
          && (request.depth ?? "").toLowerCase() === "1");
      const paths = propfinds.map((request) => request.decodedPath);
      const duplicates = paths.filter(
        (path, index) => paths.indexOf(path) !== index,
      );

      // Depth 0 的 stat 不属于列表；稳态轮的 Depth 1 恰好是
      // root／控制目录／docs 各一次。
      console.log("WEBDAV_STEADY_PROPFINDS", JSON.stringify(paths));
      expect(duplicates).toEqual([]);
    } finally {
      await harness.dispose();
    }
  }, 120_000);
});
