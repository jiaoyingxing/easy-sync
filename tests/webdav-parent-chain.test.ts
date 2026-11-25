/**
 * W2b-4：WebDAV 父级链建夹。
 *
 * 真实服务器（坚果云 L2 已核证）的 MKCOL 只建最后一级，父级缺失返回 409——
 * 它不会替你递归。`uploadFile` 与 `createFolderAt` 以前都只对**直接父级**
 * 调一次 `ensureCollection`，所以：
 *
 * - 上传 `a/b/c.md` 而 `a`、`a/b` 都不存在 ⇒ 409，上传失败；
 * - 建夹 `a/b/c` 而 `a` 不存在 ⇒ 409，建夹失败。
 *
 * 引擎在多级新目录里首批上传时会正好踩到第一种（本地有个两级的笔记库目录
 * 而远端是空的）。本文件钉住三条：
 *
 * 1. 多级新路径上传成功，远端真的出现每一级集合与你传的文件；
 * 2. 建夹保持「父级缺失上抛 409、不静默合成」的既有契约；
 * 3. 上传只为缺失层级发 MKCOL，已存在的父级不被重建。
 */
import { describe, expect, it } from "vitest";
import { WebDavClient } from "../src/providers/webdav/webdav-client";
import { WebDavProvider } from "../src/providers/webdav/webdav-provider";
import {
  createLoopbackWebDavTransport,
  FakeWebDavServer,
} from "./helpers/fake-webdav";
import { createWebDavColdStartHarness } from "./helpers/webdav-cold-start-harness";

const USERNAME = "probe";
const PASSWORD = "app-password";

async function withProvider(
  run: (ctx: {
    provider: WebDavProvider;
    fake: FakeWebDavServer;
    calls: string[];
  }) => Promise<void>,
): Promise<void> {
  const fake = new FakeWebDavServer({
    rootPath: "/vault",
    username: USERNAME,
    password: PASSWORD,
  });
  const { port } = await fake.start();
  try {
    const client = new WebDavClient({
      endpoint: "https://webdav.test/vault",
      credentials: { username: USERNAME, password: PASSWORD },
      transport: createLoopbackWebDavTransport({ port }),
    });
    await client.initialize();
    const provider = new WebDavProvider({ client });
    const calls: string[] = [];
    const original = client.ensureCollection.bind(client);
    client.ensureCollection = async (relativePath: string) => {
      calls.push(relativePath);
      return await original(relativePath);
    };
    await run({ provider, fake, calls });
  } finally {
    await fake.stop();
  }
}

describe("W2b-4 父级链建夹", () => {
  it("多级新路径上传：每一级集合都被建出来，文件落在最深一级", async () => {
    await withProvider(async ({ provider, fake }) => {
      const text = "nested note\n";
      const bytes = new TextEncoder().encode(text);
      const result = await provider.uploadFile(
        "vault",
        "docs/sub/note.md",
        bytes.buffer as ArrayBuffer,
      );
      expect(result.id).toBe("docs/sub/note.md");
      // 远端每一级都是真实集合。
      for (const path of ["/vault/docs", "/vault/docs/sub"]) {
        expect(fake.getResource(path), path).toMatchObject({ kind: "collection" });
      }
      expect(fake.readText("/vault/docs/sub/note.md")).toBe(text);
    });
  }, 60_000);

  it("建夹不递归：父级缺失仍按契约上抛 409，不静默合成", async () => {
    // 设计 §13.3 明确要求初始化不递归猜路径：一个拼错的深层路径不该悄悄造出
    // 一整棵空目录。上传不同（引擎已决定要写这个文件，父级是执行前提），
    // 所以只有上传补齐父级链。
    await withProvider(async ({ provider, fake }) => {
      await expect(provider.createFolderPath("vault", "a/b/c"))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(fake.getResource("/vault/a")).toBeNull();
      expect(fake.getResource("/vault/a/b/c")).toBeNull();
    });
  }, 60_000);

  it("上传只为缺失层级发 MKCOL，已存在/刚建过的层级不被重建", async () => {
    await withProvider(async ({ provider, fake, calls }) => {
      // 预置 docs（但缺 docs/sub）。
      expect(await provider.createFolderPath("vault", "docs")).not.toBeNull();
      const existingETag = fake.getResource("/vault/docs")?.eTag ?? null;
      calls.length = 0;

      const bytes = new TextEncoder().encode("nested\n");
      await provider.uploadFile(
        "vault",
        "docs/sub/note.md",
        bytes.buffer as ArrayBuffer,
      );
      // docs 已由本轮的 createFolderPath 建过且被记住，上传只补缺失的
      // docs/sub；已存在的父级不再发一次幂等 MKCOL。
      expect(calls).toEqual(["docs/sub"]);
      expect(fake.getResource("/vault/docs")?.eTag ?? null).toBe(existingETag);
      expect(fake.getResource("/vault/docs/sub"))
        .toMatchObject({ kind: "collection" });
      expect(fake.readText("/vault/docs/sub/note.md")).toBe("nested\n");
    });
  }, 60_000);

  it("同一轮多个文件上传只补齐一次父级链", async () => {
    await withProvider(async ({ provider, calls }) => {
      calls.length = 0;
      const bytes = new TextEncoder().encode("file\n");
      await provider.uploadFile(
        "vault",
        "docs/a.md",
        bytes.buffer as ArrayBuffer,
      );
      await provider.uploadFile(
        "vault",
        "docs/b.md",
        bytes.buffer as ArrayBuffer,
      );
      // 第一次上传补齐 docs；第二次直接复用本轮已确认的父级。
      expect(calls).toEqual(["docs"]);
    });
  }, 60_000);
});

describe("W2b-4 父级链建夹：真实引擎首同步", () => {
  it("本地两级新目录首次同步：远端补齐整条链，次轮零计划", async () => {
    // 空远端 + 本地两级新目录里的一个文件：
    // 这是「加入一个已有内容的远端」之外最常见的首同步形状，也是以前
    // 只建直接父级时必然 409 的形状。
    const harness = await createWebDavColdStartHarness({
      profiles: ["strict"],
      localFiles: { "docs/sub/note.md": "nested\n" },
      localFolders: ["docs", "docs/sub"],
    });
    try {
      expect((await harness.runRound("manual")).message)
        .toBe("result.pausedForReview");
      expect(await harness.confirmRound(harness.state.planReviewAuthorization!))
        .toMatchObject({ success: true, errors: 0, uploaded: 1 });

      // 远端确实有两级集合与那个文件。
      for (const path of ["/vault/docs", "/vault/docs/sub"]) {
        expect(harness.fake.getResource(path), path)
          .toMatchObject({ kind: "collection" });
      }
      expect(harness.remoteText("/vault/docs/sub/note.md")).toBe("nested\n");

      // 第二轮没有新计划（建夹是幂等的，不会每轮重发 MKCOL）。
      const next = await harness.runRound("manual");
      expect(next).toMatchObject({
        uploaded: 0,
        downloaded: 0,
        foldersCreated: 0,
        errors: 0,
      });
    } finally {
      await harness.dispose();
    }
  }, 180_000);
});
