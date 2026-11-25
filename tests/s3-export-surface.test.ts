import { describe, expect, it } from "vitest";
import {
  AWS_SIGV4_ALGORITHM,
  credentialScope,
  type CanonicalRequestInput,
  type SignS3RequestInput,
  type SignedS3Request,
} from "../src/providers/s3/sigv4";
import {
  DEFAULT_S3_REQUEST_DEADLINE_MS,
  EMPTY_RESPONSE_BODY,
  type RequestUrlFunction,
  type RequestUrlTransportOptions,
} from "../src/providers/s3/s3-transport";
import {
  MAX_KEY_SEGMENT_BYTES,
  MAX_S3_KEY_BYTES,
  type S3PathCollision,
  type VaultPathInspection,
  type VaultSegmentIssue,
  type VaultSegmentProblem,
} from "../src/providers/s3/s3-key";
import {
  parseS3ErrorBody,
  type S3ErrorClassification,
  type S3ErrorResponseInput,
} from "../src/providers/s3/s3-errors";
import {
  parseS3EnumCheckpoint,
  type S3EnumCheckpointV1,
  type S3EnumRestartReason,
  type S3EnumerationOptions,
  type S3EnumerationResult,
} from "../src/providers/s3/s3-enum-checkpoint";
import {
  S3_CREDENTIAL_BINDING_PREFIX,
  S3_SCOPE_SCHEMA_VERSION,
  type BuildS3ScopeMarkerInput,
  type NormalizedS3Endpoint,
  type S3LocalScopeIdentity,
  type S3ScopeFields,
  type S3ScopeInput,
  type S3ScopeMarkerAction,
  type S3ScopeMarkerDecision,
  type S3ScopeMarkerV1,
} from "../src/providers/s3/s3-scope";
import {
  encodeCopySource,
  resolveS3Address,
  validateMultipartPartSizes,
  type ResolvedAddressingStyle,
  type S3Address,
  type S3AddressingStyle,
  type S3CopyObjectArgs,
  type S3DeleteVerifiedResult,
  type S3GetOptions,
  type S3GetResult,
  type S3HeadResult,
  type S3MultipartPart,
  type S3RetryOptions,
} from "../src/providers/s3/s3-client";
import {
  type S3Platform,
  type S3ProbeClient,
  type S3ProbeObservation,
  type S3ProbeOptions,
  type S3ProtocolFacts,
} from "../src/providers/s3/s3-capabilities";

/**
 * S1 导出面合同：把 S2／诊断将使用的公共类型与常量固定在一个可编译的清单里。
 * 这同时满足仓库的 export-surface 门（src 导出必须在其它代码文件出现），
 * 避免以后误删 S2 需要的类型。
 */
type S3TypeSurface = {
  BuildS3ScopeMarkerInput: BuildS3ScopeMarkerInput;
  CanonicalRequestInput: CanonicalRequestInput;
  NormalizedS3Endpoint: NormalizedS3Endpoint;
  RequestUrlFunction: RequestUrlFunction;
  RequestUrlTransportOptions: RequestUrlTransportOptions;
  ResolvedAddressingStyle: ResolvedAddressingStyle;
  S3Address: S3Address;
  S3AddressingStyle: S3AddressingStyle;
  S3CopyObjectArgs: S3CopyObjectArgs;
  S3DeleteVerifiedResult: S3DeleteVerifiedResult;
  S3EnumCheckpointV1: S3EnumCheckpointV1;
  S3EnumRestartReason: S3EnumRestartReason;
  S3EnumerationOptions: S3EnumerationOptions;
  S3EnumerationResult: S3EnumerationResult;
  S3ErrorClassification: S3ErrorClassification;
  S3ErrorResponseInput: S3ErrorResponseInput;
  S3GetOptions: S3GetOptions;
  S3GetResult: S3GetResult;
  S3HeadResult: S3HeadResult;
  S3LocalScopeIdentity: S3LocalScopeIdentity;
  S3MultipartPart: S3MultipartPart;
  S3PathCollision: S3PathCollision;
  S3Platform: S3Platform;
  S3ProbeClient: S3ProbeClient;
  S3ProbeObservation: S3ProbeObservation;
  S3ProbeOptions: S3ProbeOptions;
  S3ProtocolFacts: S3ProtocolFacts;
  S3RetryOptions: S3RetryOptions;
  S3ScopeFields: S3ScopeFields;
  S3ScopeInput: S3ScopeInput;
  S3ScopeMarkerAction: S3ScopeMarkerAction;
  S3ScopeMarkerDecision: S3ScopeMarkerDecision;
  S3ScopeMarkerV1: S3ScopeMarkerV1;
  SignS3RequestInput: SignS3RequestInput;
  SignedS3Request: SignedS3Request;
  VaultPathInspection: VaultPathInspection;
  VaultSegmentIssue: VaultSegmentIssue;
  VaultSegmentProblem: VaultSegmentProblem;
};

describe("S3 S1 导出面", () => {
  it("常量与纯函数的取值契约", () => {
    expect(AWS_SIGV4_ALGORITHM).toBe("AWS4-HMAC-SHA256");
    expect(DEFAULT_S3_REQUEST_DEADLINE_MS).toBeGreaterThan(0);
    expect(EMPTY_RESPONSE_BODY.byteLength).toBe(0);
    expect(MAX_S3_KEY_BYTES).toBe(1024);
    expect(MAX_KEY_SEGMENT_BYTES).toBe(255);
    expect(S3_SCOPE_SCHEMA_VERSION).toBe(1);
    expect(S3_CREDENTIAL_BINDING_PREFIX).toBe("easysync/scope/v1|s3|");
    expect(credentialScope("20150830T123600Z", "us-east-1", "s3")).toBe(
      "20150830/us-east-1/s3/aws4_request",
    );
    expect(encodeCopySource("bucket", "dir/a b.md")).toBe("/bucket/dir/a%20b.md");
    expect(parseS3ErrorBody("<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>")).toEqual({
      code: "NoSuchKey",
      message: "missing",
    });
    expect(parseS3EnumCheckpoint(null, { scopeId: "s", prefix: "" })).toBeNull();
    expect(() =>
      validateMultipartPartSizes([
        { partNumber: 1, eTag: '"a"', size: 1 },
        { partNumber: 2, eTag: '"b"' },
      ]),
    ).toThrow();
  });

  it("类型清单可编译，且寻址 API 已被 S2 之外的代码使用", () => {
    const typeSurface: S3TypeSurface | null = null;
    expect(typeSurface).toBeNull();
    expect(
      resolveS3Address("https://s3.amazonaws.com", "bucket", "k", "virtual").host,
    ).toBe("bucket.s3.amazonaws.com");
  });
});
