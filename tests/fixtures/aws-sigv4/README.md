# AWS SigV4 官方测试向量

来源：`https://github.com/aws/aws-sdk-ruby/tree/master/gems/aws-sigv4/spec/suite`
（Apache-2.0；2026-11-17 通过 GitHub Contents API 原样下载）。

本目录的 16 个用例（64 个文件）均已用官方目录逐字节核对（本地 blob SHA
与官方一致）。

每个用例包含：

- `.req`：原始 HTTP 请求（含 BOM 的按原样保留，测试解析时去掉）；
- `.creq`：AWS 期望的规范请求；
- `.sts`：期望的待签串；
- `.authz`：期望的 `Authorization`（含 `SignedHeaders` 与 `Signature`）。

只保留适用于 S3 的用例。AWS 通用套件里的 `normalize-path`（折叠 `//`、
消除 `.`／`..`）**不适用于 S3**：S3 的 key 允许这些形态，且 AWS 明确要求
S3 不做路径归一化。`get-slashes` 同理不纳入。
