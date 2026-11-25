import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  probeS3Capabilities,
  S3_CAPABILITIES,
  s3Capabilities,
  s3ProtocolFacts,
  S3_MAX_SINGLE_GET_BYTES_DESKTOP,
  S3_MAX_SINGLE_GET_BYTES_MOBILE,
  S3_MAX_SINGLE_PUT_BYTES_DESKTOP,
  S3_MAX_SINGLE_PUT_BYTES_MOBILE,
} from "../src/providers/s3/s3-capabilities";
import { S3Client } from "../src/providers/s3/s3-client";
import { FakeS3Server, type FakeS3Profile } from "./helpers/fake-s3";
import { createFetchS3Transport } from "./helpers/s3-transport";

/**
 * 能力声明与探针合同：14 位能力位、3 项协议事实、逐会话探测与 quirk profile
 * 驱动的降级。探针只碰 `.easy-sync/probe/` 控制面对象并清理。
 */
let fake: FakeS3Server;
let client: S3Client;
let endpoint = "";

beforeAll(async () => {
  fake = new FakeS3Server();
  const started = await fake.start();
  endpoint = started.endpoint;
  expect(started.port).toBeGreaterThan(0);
  client = newClient("aws-like");
});

afterAll(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
});

afterEach(() => {
  expect(fake.violations).toEqual([]);
});

function newClient(profile: FakeS3Profile): S3Client {
  void profile;
  return new S3Client({
    endpoint,
    region: "us-east-1",
    bucket: fake.bucket,
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
    transport: createFetchS3Transport(),
    retry: { maxAttempts: 1, sleep: async () => undefined },
  });
}

/** 每个 quirk 独立起一个 fake，避免 profile 构造期固定值影响共享服务。 */
async function withProbeServer(
  options: ConstructorParameters<typeof FakeS3Server>[0],
  suffix: string,
  run: (
    result: Awaited<ReturnType<typeof probeS3Capabilities>>,
    server: FakeS3Server,
  ) => void | Promise<void>,
): Promise<void> {
  const server = new FakeS3Server(options);
  const started = await server.start();
  try {
    const probeClient = new S3Client({
      endpoint: started.endpoint,
      region: "us-east-1",
      bucket: server.bucket,
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      transport: createFetchS3Transport(),
      retry: { maxAttempts: 1, sleep: async () => undefined },
    });
    const result = await probeS3Capabilities(probeClient, {
      platform: "desktop",
      randomSuffix: () => suffix,
    });
    await run(result, server);
    expect(server.violations).toEqual([]);
  } finally {
    await server.stop();
  }
}

describe("14 位能力与协议事实", () => {
  it("AWS 基准的静态声明", () => {
    const capabilities = s3Capabilities("desktop");
    expect(Object.keys(capabilities).sort()).toEqual(
      [
        "conditionalCreate",
        "conditionalDelete",
        "conditionalUpdate",
        "contentChecksum",
        "contentVersionToken",
        "deltaCursor",
        "folderEntity",
        "maxSinglePutBytes",
        "rangeDownload",
        "recycleBin",
        "resumableUpload",
        "serverSideMove",
        "stableIdentity",
        "versionHistory",
      ].sort(),
    );
    expect(capabilities.stableIdentity).toBe(false);
    expect(capabilities.serverSideMove).toBe(false);
    expect(capabilities.deltaCursor).toBe(false);
    expect(capabilities.folderEntity).toBe(false);
    expect(capabilities.contentChecksum).toBe(false);
    expect(capabilities.rangeDownload).toBe(true);
    expect(capabilities.resumableUpload).toBe(true);
    expect(capabilities.conditionalCreate).toBe(true);
    expect(capabilities.conditionalUpdate).toBe(true);
    expect(capabilities.conditionalDelete).toBe(true);
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(S3_CAPABILITIES).toEqual(capabilities);
  });

  it("桌面与手机的 maxSinglePutBytes／maxSingleGetBytes 初始值", () => {
    expect(s3Capabilities("desktop").maxSinglePutBytes).toBe(S3_MAX_SINGLE_PUT_BYTES_DESKTOP);
    expect(s3Capabilities("mobile").maxSinglePutBytes).toBe(S3_MAX_SINGLE_PUT_BYTES_MOBILE);
    expect(s3ProtocolFacts("desktop").maxSingleGetBytes).toBe(S3_MAX_SINGLE_GET_BYTES_DESKTOP);
    expect(s3ProtocolFacts("mobile").maxSingleGetBytes).toBe(S3_MAX_SINGLE_GET_BYTES_MOBILE);
    expect(s3ProtocolFacts("desktop").listingConsistency).toBe("strong");
    expect(s3ProtocolFacts("desktop").conditionalCopyTarget).toBe(true);
  });
});

describe("逐会话探针", () => {
  it("aws-like：条件位全部成立，探针对象清理干净", async () => {
    const result = await probeS3Capabilities(newClient("aws-like"), {
      platform: "desktop",
      randomSuffix: () => "aws",
    });
    expect(result.capabilities.conditionalCreate).toBe(true);
    expect(result.capabilities.conditionalUpdate).toBe(true);
    expect(result.capabilities.conditionalDelete).toBe(true);
    expect(result.protocolFacts.conditionalCopyTarget).toBe(true);
    expect(result.protocolFacts.listingConsistency).toBe("strong");
    expect(result.observations.every((observation) => observation.passed)).toBe(true);
    expect(fake.getObjectSnapshot(".easy-sync/probe/aws-create")).toBeNull();
    expect(fake.getObjectSnapshot(".easy-sync/probe/aws-copy-source")).toBeNull();
    expect(fake.getObjectSnapshot(".easy-sync/probe/aws-copy-target")).toBeNull();
    expect(fake.getObjectSnapshot(".easy-sync/probe/aws-copy-fresh-target")).toBeNull();
    expect(fake.getObjectSnapshot(".easy-sync/probe/aws-list-1")).toBeNull();
    expect(fake.getObjectSnapshot(".easy-sync/probe/aws-list-2")).toBeNull();
    expect(fake.getObjectSnapshot(".easy-sync/probe/aws-list-3")).toBeNull();
    // 探针对象属于控制面，不能计入用户内容 mutation。
    expect(fake.snapshotStats().userContent).toEqual({ put: 0, copy: 0, delete: 0 });
    expect(fake.violations).toEqual([]);
  });

  it("minio-like：path-style Host 与路径形态符合 MinIO 期望", async () => {
    const minioServer = new FakeS3Server({ profile: "minio-like" });
    const started = await minioServer.start();
    try {
      const minioClient = new S3Client({
        endpoint: started.endpoint,
        region: "us-east-1",
        bucket: minioServer.bucket,
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
        transport: createFetchS3Transport(),
        retry: { maxAttempts: 1, sleep: async () => undefined },
      });
      await minioClient.putObjectCreateOnly("dir/note.md", new TextEncoder().encode("x").buffer as ArrayBuffer);
      expect(minioServer.violations).toEqual([]);
      expect(minioServer.requests[0].headers.host).toBe(`127.0.0.1:${started.port}`);
      expect(minioServer.requests[0].key).toBe("dir/note.md");
    } finally {
      await minioServer.stop();
    }
  });

  it("r2-like：目标条件 COPY 与条件删除被忽略 → 能力降级", async () => {
    // fake 的 profile 是构造期固定值；用独立 server 才能切换 quirk。
    const r2Server = new FakeS3Server({ profile: "r2-like" });
    const started = await r2Server.start();
    try {
      const r2Client = new S3Client({
        endpoint: started.endpoint,
        region: "us-east-1",
        bucket: r2Server.bucket,
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
        transport: createFetchS3Transport(),
        retry: { maxAttempts: 1, sleep: async () => undefined },
      });
      const result = await probeS3Capabilities(r2Client, {
        platform: "desktop",
        randomSuffix: () => "r2",
      });
      expect(result.capabilities.conditionalCreate).toBe(true);
      expect(result.capabilities.conditionalUpdate).toBe(true);
      expect(result.capabilities.conditionalDelete).toBe(false);
      expect(result.protocolFacts.conditionalCopyTarget).toBe(false);
      expect(r2Server.getObjectSnapshot(".easy-sync/probe/r2-copy-target")).toBeNull();
      expect(r2Server.violations).toEqual([]);
    } finally {
      await r2Server.stop();
    }
  });

  it("PUT 条件被忽略 → conditionalCreate / conditionalUpdate 降为 false", async () => {
    const blindServer = new FakeS3Server({
      ignorePutIfNoneMatch: true,
      ignorePutIfMatch: true,
    });
    const started = await blindServer.start();
    try {
      const blindClient = new S3Client({
        endpoint: started.endpoint,
        region: "us-east-1",
        bucket: blindServer.bucket,
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
        transport: createFetchS3Transport(),
        retry: { maxAttempts: 1, sleep: async () => undefined },
      });
      const result = await probeS3Capabilities(blindClient, {
        platform: "desktop",
        randomSuffix: () => "blind",
      });
      expect(result.capabilities.conditionalCreate).toBe(false);
      expect(result.capabilities.conditionalUpdate).toBe(false);
      expect(
        result.observations.some(
          (observation) => observation.step === "conditionalCreate:collision" && !observation.passed,
        ),
      ).toBe(true);
      expect(
        result.observations.some(
          (observation) => observation.step === "conditionalUpdate:stale" && !observation.passed,
        ),
      ).toBe(true);
      expect(blindServer.violations).toEqual([]);
    } finally {
      await blindServer.stop();
    }
  });

  it("条件更新 2xx 但未落盘 → conditionalUpdate=false", async () => {
    await withProbeServer({ putIfMatchWithoutWrite: true }, "no-write", (result) => {
      expect(result.capabilities.conditionalUpdate).toBe(false);
      const observation = result.observations.find((entry) => entry.step === "conditionalUpdate:current");
      expect(observation?.passed).toBe(false);
      expect(observation?.observed).toMatch(/not updated/);
    });
  });

  it("条件删除 204 但对象仍在 → conditionalDelete=false", async () => {
    await withProbeServer({ deleteWithoutEffect: true }, "no-delete", (result) => {
      expect(result.capabilities.conditionalDelete).toBe(false);
      const observation = result.observations.find((entry) => entry.step === "delete:verify");
      expect(observation?.passed).toBe(false);
      expect(observation?.observed).toMatch(/still returns 200/);
    });
  });

  it("HEAD 无 ETag → conditionalDelete=false", async () => {
    await withProbeServer({ headWithoutETag: true }, "no-etag", (result) => {
      expect(result.capabilities.conditionalDelete).toBe(false);
      const observation = result.observations.find((entry) => entry.step === "conditionalDelete:precondition");
      expect(observation?.passed).toBe(false);
      expect(observation?.observed).toMatch(/no ETag/);
    });
  });

  it("COPY 返回 412 但仍覆盖目标 → conditionalCopyTarget=false", async () => {
    await withProbeServer({ copyPreconditionOverwritesTarget: true }, "copy-overwrite", (result) => {
      expect(result.protocolFacts.conditionalCopyTarget).toBe(false);
      const observation = result.observations.find((entry) => entry.step === "conditionalCopyTarget");
      expect(observation?.passed).toBe(false);
      expect(observation?.observed).toMatch(/changed/);
    });
  });

  it("COPY 一律 412：阳性对照失败 → conditionalCopyTarget=false", async () => {
    await withProbeServer({ copyAlwaysPreconditionFailed: true }, "copy-reject", (result) => {
      expect(result.protocolFacts.conditionalCopyTarget).toBe(false);
      expect(result.observations.find((entry) => entry.step === "conditionalCopyTarget")?.passed).toBe(true);
      expect(result.observations.find((entry) => entry.step === "conditionalCopyTarget:absent-target")?.passed).toBe(
        false,
      );
    });
  });

  it("LIST 暂不可见 → listingConsistency=eventual", async () => {
    fake.hideKeyFromList(".easy-sync/probe/eventual-list-1");
    fake.hideKeyFromList(".easy-sync/probe/eventual-list-2");
    fake.hideKeyFromList(".easy-sync/probe/eventual-list-3");
    const result = await probeS3Capabilities(client, {
      platform: "desktop",
      randomSuffix: () => "eventual",
    });
    expect(result.protocolFacts.listingConsistency).toBe("eventual");
    expect(
      result.observations.some(
        (observation) => observation.step === "listingConsistency" && !observation.passed,
      ),
    ).toBe(true);
  });
});
