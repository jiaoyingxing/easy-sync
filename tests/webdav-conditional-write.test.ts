import { describe, expect, it } from "vitest";
import { buildWebDavIfHeader } from "../src/providers/webdav/webdav-probe";
import { installWebDavProbeFixture } from "./helpers/webdav-probe-fixture";

/**
 * W1 验收：条件写与条件删除。
 *
 * 负向用例必须证明服务端对象没被覆盖：旧 SHA 不变＋写计数不变。探针侧
 * `conditionalUpdate` 还要求写入后回读字节，不能只看 2xx。
 */
const fixture = installWebDavProbeFixture();

describe("严格服务器", () => {
  it("create-only、If-Match 更新、条件删除与 HEAD 都通过", async () => {
    const result = await fixture.runProbe();
    expect(result.capabilities).toMatchObject({
      conditionalCreate: true,
      conditionalUpdate: true,
      conditionalDelete: true,
    });
    expect(result.protocolFacts).toMatchObject({
      head: true,
      etagPresent: true,
      weakETag: false,
    });
    expect(result.observations.filter((observation) => !observation.passed)).toEqual([]);
  });

  it("RFC 4918 If 头构造为 If: ([\"etag\"])", () => {
    expect(buildWebDavIfHeader('"abc"')).toBe('(["abc"])');
  });
});

describe("条件写降级", () => {
  it("弱 ETag：conditionalUpdate 与 conditionalDelete 同时为 false", async () => {
    const result = await fixture.runProbe(["weak-etag"]);
    expect(result.protocolFacts).toMatchObject({ etagPresent: true, weakETag: true });
    expect(result.capabilities.conditionalCreate).toBe(true);
    expect(result.capabilities.conditionalUpdate).toBe(false);
    expect(result.capabilities.conditionalDelete).toBe(false);
    expect(result.observations.some((o) => o.step === "conditionalUpdate:weak-etag" && o.passed)).toBe(true);
    expect(result.observations.some((o) => o.step === "conditionalDelete:weak-etag" && o.passed)).toBe(true);
  });

  it("服务器忽略 If-Match 与 If：陈旧写入被接受，两项条件能力都降为 false", async () => {
    const result = await fixture.runProbe(["no-if-match"]);
    expect(result.protocolFacts.weakETag).toBe(false);
    expect(result.capabilities.conditionalUpdate).toBe(false);
    expect(result.capabilities.conditionalDelete).toBe(false);
    expect(result.observations.find((o) => o.step === "conditionalUpdate:stale")?.passed).toBe(false);
    expect(result.observations.find((o) => o.step === "conditionalDelete:stale")?.passed).toBe(false);
  });

  it("只认 RFC 4918 If 的服务器：按 If 头回退后条件更新／删除仍为 true", async () => {
    const result = await fixture.runProbe(["if-header-only"]);
    expect(result.capabilities.conditionalUpdate).toBe(true);
    expect(result.capabilities.conditionalDelete).toBe(true);
    expect(result.observations.find((o) => o.step === "conditionalUpdate:rfc4918-if")?.passed).toBe(true);
    expect(result.observations.find((o) => o.step === "conditionalDelete:rfc4918-if")?.passed).toBe(true);
  });

  it("2xx 但未落盘的服务器：conditionalUpdate 必须为 false", async () => {
    const result = await fixture.runProbe(["put-2xx-without-write"]);
    expect(result.capabilities.conditionalUpdate).toBe(false);
    expect(
      result.observations.find((o) => o.step === "conditionalUpdate:current")?.passed,
    ).toBe(false);
  });

  it("207 multistatus 内 per-response 404：删除后仍判为不存在，不降级条件删除", async () => {
    const result = await fixture.runProbe(["propfind-404-body"]);
    expect(result.capabilities.conditionalDelete).toBe(true);
    expect(
      result.observations.find((o) => o.step === "conditionalDelete:current")?.passed,
    ).toBe(true);
  });
});

describe("fake 自身真实判定（防空转假绿）", () => {
  it("create-only 撞已有 → 412，对象 SHA 与写计数都不变", async () => {
    fixture.fake.seedFile("/note.md", "original");
    const response = await fixture.raw("PUT", "/note.md", { "If-None-Match": "*" }, "replacement");
    expect(response.status).toBe(412);
    expect(fixture.fake.getResource("/note.md")?.sha256).toBe(fixture.sha256("original"));
    expect(fixture.fake.mutationCounts("/note.md").put).toBe(0);
  });

  it("探针路径已被用户对象占用时不登记清理，不删除该对象", async () => {
    const occupied = "/.easy-sync-probe-fixed-base.md";
    fixture.fake.seedFile(occupied, "user content");
    const result = await fixture.runProbe();
    expect(result.capabilities.conditionalCreate).toBe(false);
    expect(fixture.fake.readText(occupied)).toBe("user content");
  });

  it("stale If-Match 更新／删除 → 412，对象 SHA 与写计数都不变", async () => {
    fixture.fake.seedFile("/note.md", "original");
    const update = await fixture.raw("PUT", "/note.md", { "If-Match": '"stale"' }, "replacement");
    expect(update.status).toBe(412);
    expect(fixture.fake.getResource("/note.md")?.sha256).toBe(fixture.sha256("original"));
    expect(fixture.fake.mutationCounts("/note.md").put).toBe(0);

    const remove = await fixture.raw("DELETE", "/note.md", { "If-Match": '"stale"' });
    expect(remove.status).toBe(412);
    expect(fixture.fake.getResource("/note.md")?.sha256).toBe(fixture.sha256("original"));
    expect(fixture.fake.mutationCounts("/note.md").delete).toBe(0);
  });
});
