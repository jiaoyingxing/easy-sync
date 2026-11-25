import { describe, expect, it } from "vitest";
import { encodeWebDavPath } from "../src/providers/webdav/webdav-probe";
import { installWebDavProbeFixture } from "./helpers/webdav-probe-fixture";

/**
 * W1 验收：MOVE 与 Overwrite: F。
 *
 * `Overwrite: F` 只有「412 且目标字节未变」才算通过；只看状态码会把
 * 「先覆盖再报 412」的服务器误判为安全。
 */
const fixture = installWebDavProbeFixture();

describe("MOVE 合同", () => {
  it("严格服务器：目标已存在 F → 412 且目标未变，缺目标 MOVE 成功", async () => {
    const result = await fixture.runProbe();
    expect(result.protocolFacts).toMatchObject({
      moveOverwriteReject: true,
      moveDestinationEncoding: true,
    });
    expect(result.capabilities.serverSideMove).toBe(true);
    expect(result.observations.find((o) => o.step === "move:overwrite-f")?.observed).toMatch(/unchanged/);
  });

  it("用 409 DuplicateName 拒绝覆盖且目标未变：serverSideMove 仍为 true", async () => {
    // 坚果云实测：目标已存在 + Overwrite: F 返回 409，不是 RFC 的 412；
    // 语义仍是「拒绝覆盖」，只要目标字节未变就可以作为安全新建的 MOVE 依据。
    const result = await fixture.runProbe(["move-conflict-on-overwrite"]);
    expect(result.protocolFacts.moveOverwriteReject).toBe(true);
    expect(result.capabilities.serverSideMove).toBe(true);
    expect(result.observations.find((o) => o.step === "move:overwrite-f")?.observed).toMatch(
      /HTTP 409; destination unchanged/,
    );
  });

  it("服务器忽略 Overwrite: F：目标被覆盖，serverSideMove 必须为 false", async () => {
    const result = await fixture.runProbe(["ignore-overwrite-f"]);
    expect(result.protocolFacts.moveOverwriteReject).toBe(false);
    expect(result.capabilities.serverSideMove).toBe(false);
    expect(result.observations.find((o) => o.step === "move:overwrite-f")?.observed).toMatch(/ignored/);
  });

  it("返回 412 但实际覆盖目标：回读发现字节变化，不能判为安全", async () => {
    const result = await fixture.runProbe(["412-overwrites-target"]);
    expect(result.protocolFacts.moveOverwriteReject).toBe(false);
    expect(result.capabilities.serverSideMove).toBe(false);
    expect(result.observations.find((o) => o.step === "move:overwrite-f")?.observed).toMatch(/modified/);
  });

  it("207 multistatus 内 per-response 404：源仍判为已消失，serverSideMove 不降级", async () => {
    const result = await fixture.runProbe(["propfind-404-body"]);
    expect(result.capabilities.serverSideMove).toBe(true);
    expect(result.observations.find((o) => o.step === "move:source-absent")?.passed).toBe(true);
  });

  it("MOVE 报成功但目标未落盘：207+404 目标不能判为存在", async () => {
    const result = await fixture.runProbe(["propfind-404-body", "move-201-without-destination"]);
    expect(result.capabilities.serverSideMove).toBe(false);
    expect(result.observations.find((o) => o.step === "move:destination-present")?.passed).toBe(false);
  });

  it("无 MOVE：serverSideMove=false，MOVE Destination 编码不算通过", async () => {
    const result = await fixture.runProbe(["no-move"]);
    expect(result.capabilities.serverSideMove).toBe(false);
    expect(result.protocolFacts.moveOverwriteReject).toBe(false);
    expect(result.protocolFacts.moveDestinationEncoding).toBe(false);
    expect(result.protocolFacts.pathEncodingRoundTrip).toBe(true);
    expect(result.observations.find((o) => o.step === "move:overwrite-f")?.observed).toMatch(/405/);
    expect(result.observations.find((o) => o.step === "encoding:move-destination")?.passed).toBe(false);
  });
});

describe("fake 自身真实判定（防空转假绿）", () => {
  it("MOVE 目标已存在 + Overwrite: F → 412，目标 SHA 不变", async () => {
    fixture.fake.seedFile("/source.md", "source");
    fixture.fake.seedFile("/target.md", "target");
    const destination = `http://127.0.0.1:${fixture.port}${encodeWebDavPath("/target.md")}`;
    const response = await fixture.raw("MOVE", "/source.md", {
      Destination: destination,
      Overwrite: "F",
    });
    expect(response.status).toBe(412);
    expect(fixture.fake.getResource("/target.md")?.sha256).toBe(fixture.sha256("target"));
    expect(fixture.fake.mutationCounts("/source.md").move).toBe(0);
  });
});
