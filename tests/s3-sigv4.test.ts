import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import {
  buildCanonicalRequest,
  buildStringToSign,
  calculateSignature,
  canonicalQueryString,
  canonicalUri,
  EMPTY_PAYLOAD_SHA256,
  formatAmzDate,
  signS3Request,
} from "../src/providers/s3/sigv4";
import { resolveS3Address } from "../src/providers/s3/s3-client";

/**
 * AWS 官方 SigV4 测试向量（`aws/aws-sdk-ruby` 的 `gems/aws-sigv4/spec/suite`）。
 *
 * 向量逐字比对「规范请求 → 待签串 → 签名」三段；签名正确性不靠 fake 重算，
 * 而是靠这组官方向量证明，再由 L2 MinIO 接受请求作为第二证据。
 *
 * 选择范围：只保留适用于 S3 的用例。AWS 通用套件里的 `normalize-path`
 * （折叠 `//`、消除 `.`／`..`）不适用于 S3——S3 的 key 允许这些形态，且 AWS
 * 明确要求 S3 不做路径归一化；因此这些用例不在此处。
 */
const SUITE_DIR = fileURLToPath(new URL("./fixtures/aws-sigv4/", import.meta.url));

const AWS_TEST_ACCESS_KEY = "AKIDEXAMPLE";
const AWS_TEST_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const AWS_TEST_REGION = "us-east-1";
const AWS_TEST_SERVICE = "service";
const AWS_TEST_DATE = "20150830T123600Z";

const VECTOR_CASES = [
  "get-vanilla",
  "get-vanilla-query",
  "get-vanilla-query-order-key-case",
  "get-vanilla-query-unreserved",
  "get-vanilla-utf8-query",
  "get-unreserved",
  "get-utf8",
  "get-header-key-duplicate",
  "get-header-value-multiline",
  "get-header-value-trim",
  "get-header-value-order",
  "post-vanilla",
  "post-vanilla-query-space",
  "post-vanilla-query-nonunreserved",
  "post-x-www-form-urlencoded",
  "post-x-www-form-urlencoded-parameters",
] as const;

interface ParsedVectorRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string[]>>;
  readonly body: string;
}

function readVector(caseName: string, extension: string): string {
  const text = readFileSync(`${SUITE_DIR}/${caseName}/${caseName}.${extension}`, "utf8");
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

function parseVectorRequest(text: string): ParsedVectorRequest {
  const normalized = text.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  const head = separator < 0 ? normalized : normalized.slice(0, separator);
  const body = separator < 0 ? "" : normalized.slice(separator + 2);
  const lines = head.split("\n").filter((line) => line.length > 0);
  const requestLine = lines[0];
  const firstSpace = requestLine.indexOf(" ");
  const lastSpace = requestLine.lastIndexOf(" ");
  const method = requestLine.slice(0, firstSpace);
  const target = requestLine.slice(firstSpace + 1, lastSpace);
  const question = target.indexOf("?");
  const path = question < 0 ? target : target.slice(0, question);
  const query = question < 0 ? "" : target.slice(question + 1);
  const headers: Record<string, string[]> = {};
  let currentName: string | null = null;
  for (const line of lines.slice(1)) {
    if (/^[ \t]/.test(line) && currentName !== null) {
      const values = headers[currentName];
      values[values.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    currentName = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1);
    if (!headers[currentName]) headers[currentName] = [];
    headers[currentName].push(value);
  }
  return { method, path, query, headers, body };
}

function parseAuthorization(authz: string): {
  credential: string;
  signedHeaders: string[];
  signature: string;
} {
  const match = /^AWS4-HMAC-SHA256 Credential=([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/.exec(
    authz.trim(),
  );
  if (!match) throw new Error(`Unrecognized Authorization vector: ${authz}`);
  return {
    credential: match[1],
    signedHeaders: match[2].split(";"),
    signature: match[3],
  };
}

async function vectorPayloadHash(body: string): Promise<string> {
  if (body.length === 0) return EMPTY_PAYLOAD_SHA256;
  const bytes = new TextEncoder().encode(body);
  return sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

describe("SigV4 官方向量", () => {
  for (const caseName of VECTOR_CASES) {
    it(`${caseName}：规范请求、待签串与签名逐字相等`, async () => {
      const request = parseVectorRequest(readVector(caseName, "req"));
      const expectedCanonicalRequest = readVector(caseName, "creq").trimEnd();
      const expectedStringToSign = readVector(caseName, "sts").trimEnd();
      const authorization = parseAuthorization(readVector(caseName, "authz"));
      const payloadHash = await vectorPayloadHash(request.body);

      const canonicalRequest = buildCanonicalRequest({
        method: request.method,
        path: request.path,
        query: request.query,
        headers: request.headers,
        signedHeaders: authorization.signedHeaders,
        payloadHash,
      });
      expect(canonicalRequest).toBe(expectedCanonicalRequest);

      const stringToSign = await buildStringToSign({
        canonicalRequest,
        amzDate: AWS_TEST_DATE,
        region: AWS_TEST_REGION,
        service: AWS_TEST_SERVICE,
      });
      expect(stringToSign).toBe(expectedStringToSign);
      expect(stringToSign.split("\n")[2]).toBe(
        `${AWS_TEST_DATE.slice(0, 8)}/${AWS_TEST_REGION}/${AWS_TEST_SERVICE}/aws4_request`,
      );

      const signature = await calculateSignature({
        stringToSign,
        secretAccessKey: AWS_TEST_SECRET,
        amzDate: AWS_TEST_DATE,
        region: AWS_TEST_REGION,
        service: AWS_TEST_SERVICE,
      });
      expect(signature).toBe(authorization.signature);
      expect(authorization.credential.split("/")[0]).toBe(AWS_TEST_ACCESS_KEY);
    });
  }
});

describe("S3 高层签名与寻址", () => {
  const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: AWS_TEST_SECRET };

  it("固定时间生成 UTC x-amz-date 与必需的 SignedHeaders", async () => {
    const signed = await signS3Request({
      method: "PUT",
      host: "examplebucket.s3.amazonaws.com",
      path: "/a b/中文+😀#%.md",
      headers: { "content-type": "text/plain" },
      body: new TextEncoder().encode("hello").buffer as ArrayBuffer,
      region: "us-east-1",
      credentials,
      amzDate: "20130524T000000Z",
    });
    expect(signed.amzDate).toBe("20130524T000000Z");
    expect(signed.signedHeaders).toEqual(
      expect.arrayContaining(["host", "x-amz-content-sha256", "x-amz-date", "content-type"]),
    );
    expect(signed.headers.authorization).toContain(
      "Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    expect(signed.headers.authorization).toContain(`SignedHeaders=${signed.signedHeaders.join(";")}`);
    expect(signed.headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(signed.canonicalRequest).toContain(
      "/a%20b/%E4%B8%AD%E6%96%87%2B%F0%9F%98%80%23%25.md",
    );
    expect(signed.payloadHash).toBe(
      await sha256Hex(new TextEncoder().encode("hello").buffer as ArrayBuffer),
    );
  });

  it("临时凭据的 x-amz-security-token 进入 SignedHeaders", async () => {
    const signed = await signS3Request({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/k",
      region: "us-east-1",
      credentials: { ...credentials, sessionToken: "token-with+/=" },
      amzDate: "20130524T000000Z",
    });
    expect(signed.signedHeaders).toContain("x-amz-security-token");
    expect(signed.headers["x-amz-security-token"]).toBe("token-with+/=");
  });

  it("virtual-hosted：普通域名默认虚拟主机", () => {
    const address = resolveS3Address(
      "https://s3.amazonaws.com",
      "examplebucket",
      "a/b c.md",
      "auto",
    );
    expect(address.style).toBe("virtual");
    expect(address.host).toBe("examplebucket.s3.amazonaws.com");
    expect(address.path).toBe("/a/b c.md");
    expect(address.url).toBe("https://examplebucket.s3.amazonaws.com/a/b%20c.md");
  });

  it("path-style：IP／localhost 自动切 path-style", () => {
    const ip = resolveS3Address("http://127.0.0.1:9000", "bucket", "中文 key+%.md", "auto");
    expect(ip.style).toBe("path");
    expect(ip.host).toBe("127.0.0.1:9000");
    expect(ip.path).toBe("/bucket/中文 key+%.md");
    expect(ip.url).toBe(
      "http://127.0.0.1:9000/bucket/%E4%B8%AD%E6%96%87%20key%2B%25.md",
    );
    const localhost = resolveS3Address("http://localhost:9000", "bucket", "k", "auto");
    expect(localhost.style).toBe("path");
  });

  it("bucket 名含点时自动切 path-style；显式 virtual 保持请求者选择", () => {
    expect(resolveS3Address("https://s3.amazonaws.com", "my.bucket", "k", "auto").style).toBe("path");
    expect(resolveS3Address("https://s3.amazonaws.com", "my.bucket", "k", "virtual").style).toBe("virtual");
  });

  it("查询参数先编码再按 key／value 排序", () => {
    const address = resolveS3Address("https://s3.amazonaws.com", "bucket", "", "virtual", [
      ["max-keys", "10"],
      ["list-type", "2"],
      ["prefix", "a b/"],
      ["continuation-token", "a+b/c=="],
    ]);
    expect(address.url).toBe(
      "https://bucket.s3.amazonaws.com/?continuation-token=a%2Bb%2Fc%3D%3D&list-type=2&max-keys=10&prefix=a%20b%2F",
    );
    expect(canonicalQueryString("?Param2=value2&Param1=value1")).toBe("Param1=value1&Param2=value2");
  });

  it("canonicalUri 保留空段与非 ASCII 编码", () => {
    expect(canonicalUri("//a//b/")).toBe("//a//b/");
    expect(canonicalUri("/中文 😀")).toBe("/%E4%B8%AD%E6%96%87%20%F0%9F%98%80");
    expect(canonicalUri("/%2F")).toBe("/%252F");
  });

  it("formatAmzDate 始终 UTC", () => {
    expect(formatAmzDate(new Date(Date.UTC(2013, 4, 24, 0, 0, 0)))).toBe("20130524T000000Z");
  });
});
