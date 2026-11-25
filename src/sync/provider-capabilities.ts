/**
 * 第二基座能力合同（B1）：提供方能力位的中性类型。
 *
 * 14 位能力是提供方实现的静态事实：无 I/O、无 await、无每轮参数。`true`
 * 表示服务端原语/服务级能力成立，不表示每个条目都一定带某项证据（逐条缺口
 * 见各字段注释）。字段名一旦发布不再改名；新增能力位必须同步改
 * `CapabilitySlot` 与提供方常量，槽位完整性断言与合同测试会拦住漂移。
 *
 * 本模块零 import、只承载类型：引用方一律用 `import type`，运行期被完全
 * 擦除，不进入启动预算的静态闭包。
 */
export interface ProviderCapabilities {
  /** 条目身份在改名/移动后保持不变（OneDrive：driveItem id 即身份）。 */
  readonly stableIdentity: boolean;
  /** 服务端原语支持「目标已存在则拒绝」的创建（OneDrive：
   *  `@microsoft.graph.conflictBehavior: "fail"`）。按路径建夹把 409 当已存在
   *  采纳属调用方策略，不否定该位。 */
  readonly conditionalCreate: boolean;
  /** 写入可携带预期版本，陈旧则拒绝（OneDrive：`If-Match` + 412）。 */
  readonly conditionalUpdate: boolean;
  /** 删除可携带预期版本，陈旧则拒绝（OneDrive：`If-Match`）。文件夹在
   *  personal 账号可能没有 cTag，调用方不得假定证据一定存在。 */
  readonly conditionalDelete: boolean;
  /** 服务端原语完成改名/移动，不传输内容（OneDrive：按 id PATCH name +
   *  parentReference）。 */
  readonly serverSideMove: boolean;
  /** 服务端提供增量变化游标（OneDrive：deltaLink）。 */
  readonly deltaCursor: boolean;
  /** 空文件夹是真实对象（OneDrive：folder facet）。 */
  readonly folderEntity: boolean;
  /** 服务端在文件元数据中提供强内容指纹（OneDrive：sha256Hash）。具体条目
   *  可能只有弱指纹或没有指纹；缺失是逐条证据缺口，不是能力否定。 */
  readonly contentChecksum: boolean;
  /** 文件有改名/移动不变的内容版本令牌（OneDrive：cTag）。personal 账号
   *  文件夹可能不返回 cTag，文件夹场景不得把该位当保证。 */
  readonly contentVersionToken: boolean;
  /** 服务端保留可列举的历史版本（OneDrive：`/versions`）。不保证版本内容
   *  读取的窄接口已接线。 */
  readonly versionHistory: boolean;
  /** 服务端可按已记录的条目 ID 请求恢复（OneDrive：`POST /items/{id}/restore`）。
   *  不表示可列举回收站；恢复必须先有 delta/删除记录里的 remoteId。 */
  readonly recycleBin: boolean;
  /** 服务端支持 Range 请求并返回 206 + Content-Range。本实现的多路 Range
   *  载体另有运行时门槛（桌面 Node、文件 ≥ 16 MiB）；不满足时走单流，
   *  不等于能力为 false。 */
  readonly rangeDownload: boolean;
  /** 服务端支持分块/会话续传（OneDrive：createUploadSession + Content-Range）。 */
  readonly resumableUpload: boolean;
  /** 单次 PUT 的安全切路阈值（字节）；超过阈值自动切分块/会话上传。这是
   *  本实现的切路阈值，不是服务端简单上传硬上限。 */
  readonly maxSinglePutBytes: number;
}

/** 与 `ProviderCapabilities` 逐位对应的槽位名。不导出：只服务下方完整性断言。 */
type CapabilitySlot =
  | "stableIdentity"
  | "conditionalCreate"
  | "conditionalUpdate"
  | "conditionalDelete"
  | "serverSideMove"
  | "deltaCursor"
  | "folderEntity"
  | "contentChecksum"
  | "contentVersionToken"
  | "versionHistory"
  | "recycleBin"
  | "rangeDownload"
  | "resumableUpload"
  | "maxSinglePutBytes";

/** 缺一个槽位时非 never，下方常量赋值编译红。 */
type MissingCapabilitySlot = Exclude<CapabilitySlot, keyof ProviderCapabilities>;
/** 多一个未登记槽位时非 never，下方常量赋值编译红。 */
type ExtraCapabilitySlot = Exclude<keyof ProviderCapabilities, CapabilitySlot>;
/** 双向完整性：两向都没有遗漏才算通过。 */
type CapabilitySlotsComplete =
  [MissingCapabilitySlot, ExtraCapabilitySlot] extends [never, never]
    ? true
    : never;
const capabilitySlotsComplete: CapabilitySlotsComplete = true;
void capabilitySlotsComplete;
