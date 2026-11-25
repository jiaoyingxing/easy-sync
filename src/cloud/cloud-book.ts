import { readCloudSettings } from "./cloud-settings";

/**
 * 云端「账本实例」身份与分账边界（F1）。
 *
 * 一台设备只容得下一本同步账这个前提本身没错，错的是**这本账没写自己属于
 * 谁**：基线、变更账本、同步历史全套挤在同一组落点，「这个库属于哪份远端」
 * 只有 OneDrive 登录会写。于是切到 WebDAV 后，WebDAV 的远端内容被记进
 * OneDrive 的账，切回来时 OneDrive 的文件全被判成新增。
 *
 * 本模块只回答两个问题：
 * 1. 「当前活动的是哪一本账」——一个永不显示给用户的短串；
 * 2. 「哪些数据属于这本账」——`data.json` 里跟云端走的键清单。
 *
 * ## 落点（刻意不对称）
 *
 * - **OneDrive 的账永远待在 `data.json` 顶层与原处**，一个字节都不动；
 * - **WebDAV 的账落到 `data.json` 的 `easy-sync-profiles.<id>` 命名空间**
 *   与 `state/profiles/<id>/` 目录，从空账开始。
 *
 * 为什么不做成对称的两个命名空间：对称只是好看。让 OneDrive 搬一次家是这
 * 一步最大的风险——老用户升级要迁移、迁移写错就丢基线、降级回旧版本还会读
 * 不到。而「两本账互不可见」靠的是「WebDAV 另开一份」加「WebDAV 看不见顶
 * 层」，不是「两个都搬」。这样升级零迁移，任何异常最坏也只是退回旧行为。
 */

/** OneDrive 的账实例 id；也是「账在顶层原地」的代名词。 */
const CLOUD_BOOK_ONEDRIVE = "onedrive";
/** 分账命名空间在 `data.json` 里的键名（只有非 OneDrive 的账会用到）。 */
const CLOUD_BOOK_NAMESPACE_KEY = "easy-sync-profiles";

/**
 * 跟云端走的 `data.json` 键（其余键跟这台设备走，原地不动）。
 *
 * 判据只有一句：**描述「我和云端是什么关系」的跟云端走；描述「这台设备
 * 怎么同步」的跟库走。** 分错方向的代价不一样——把设备键搬进账本，会让另
 * 一个云端继承本机的同步类别与自动同步设置（配置串味）；把账本键留在原
 * 地，则是两份远端互相覆盖基线（数据丢失）。后者严重得多，所以边界上有
 * 疑问时一律归入账本。
 *
 * 这是手写清单。`tests/cloud-book.test.ts` 会对 `src/**` 的键常量做完整性
 * 核对：改名或新增键时漏登记会变红，而不是静默留在原地。
 */
const CLOUD_BOOK_DATA_KEYS: ReadonlyArray<string> = [
  // 基线、待确认、账本、审计
  "easy-sync-base-snapshot",
  "easy-sync-size-exclusion-baseline",
  "easy-sync-pending-conflicts",
  "easy-sync-pending-remote-deletes",
  "easy-sync-pending-issues",
  "easy-sync-history",
  "easy-sync-generation",
  "easy-sync-last-sync-time",
  "easy-sync-bound-account",
  "easy-sync-mutation-ledger",
  "easy-sync-v2-mutation-ledger",
  "easy-sync-v2-manual-mutation-resolution-audit",
  "easy-sync-v2-force-reset-audit",
  "easy-sync-v2-recovery-quarantine",
  "easy-sync-deletion-ledger",
  "easy-sync-identity-ledger-snapshot",
  "easy-sync-webdav-ledger-rebuild",
  // 计划审阅（含审阅身份与授权）
  "easy-sync-plan-review-active",
  "easy-sync-plan-review-counts",
  "easy-sync-plan-review-items",
  "easy-sync-plan-review-digest",
  "easy-sync-plan-review-revision",
  "easy-sync-plan-review-scope",
  "easy-sync-plan-review-canonical-identity-v2",
  // 本机移动／删除提示与决定
  "easy-sync-local-folder-move-hints",
  "easy-sync-local-file-move-hints",
  "easy-sync-local-folder-delete-hints",
  "easy-sync-local-delete-decisions",
  "easy-sync-local-only-copies",
  "easy-sync-local-only-ignore-memory",
  "easy-sync-retained-empty-collections",
  // 社区插件远端事实
  "community-plugin-manifest-observations",
  "remote-community-plugin-catalog",
  "community-plugin-adoption-memory",
  // 云端引导与后代重建检查点
  "easy-sync-cloud-bootstrap-checkpoint-v2",
  "easy-sync-confirmed-descendant-file-reconstruction",
  // 未结的同步范围扩张动作
  "easy-sync-sync-scope-expansion",
  // 上次同步时双方对过账的同步范围指纹：跟云端走，切换后不会凭空制造一次
  // 「范围变过」的误判。
  "easy-sync-sync-path-settings-revision",
  "easy-sync-sync-path-settings-fingerprint",
  // 接管另一个同步工具留下的远端状态：这是关于某一份远端的事实。
  "rs-adoption-marker",
  // 同步模式：单向的定义就是「云端删了本机也删」，必须跟着云端存，
  // 否则切到 WebDAV 会带着那条会删文件的方向跑。
  "sync-direction",
];

const CLOUD_BOOK_DATA_KEY_SET: ReadonlySet<string> = new Set(
  CLOUD_BOOK_DATA_KEYS,
);

/** 该键是否属于账本（否则跟设备走）。 */
function isCloudBookDataKey(key: string): boolean {
  return CLOUD_BOOK_DATA_KEY_SET.has(key);
}

/** 这个 id 是否要另开一份账（OneDrive 是「原地」的兼容例外）。 */
function isScopedCloudBookId(bookId: string): boolean {
  return bookId !== CLOUD_BOOK_ONEDRIVE && bookId.length > 0;
}

/** 账本目录（相对插件目录）；OneDrive 返回 null＝原地存放。 */
export function cloudBookDirectory(bookId: string): string | null {
  return isScopedCloudBookId(bookId) ? `state/profiles/${bookId}` : null;
}

/**
 * WebDAV 的账实例 id，从持久化的坐标同步折叠而成。
 *
 * 只认三样东西：**地址、根路径、用户名**。改任一项就算换了一个云端——旧账
 * 保留但不再命中。密码（凭据版本）刻意不参与：改密码不该让同步基线失联。
 *
 * 与 `buildWebDavScopeId`（`src/providers/webdav/webdav-scope.ts`）覆盖同一
 * 组语义字段，但**刻意不是同一个哈希**：那个是远端 `scope.json` 的标记身份，
 * 走 WebCrypto SHA-256、异步；这里只是本地目录名，必须同步可得——设置加载
 * 期就要用它决定账本路径，不能为了一个目录名把 WebDAV 客户端拉进启动面
 * （启动预算门）。两者一一对应，界面永不显示这个串。
 */
function webDavBookIdFromCoordinates(coordinates: {
  readonly url: string;
  readonly username: string;
  readonly rootPrefix: string;
}): string {
  const material = [
    "easysync/book/v1",
    "webdav",
    coordinates.url,
    coordinates.rootPrefix,
    coordinates.username,
  ].join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `webdav-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * 把物理形状的插件数据摊成「当前这本账的视图」。
 *
 * - OneDrive：账本键就在顶层，原样可见；命名空间整个不暴露。
 * - 其他账：**账本键只从自己的命中**，顶层那些是 OneDrive 的，一律遮掉。
 *   没有自己的命中＝空账，绝不回退到顶层——回退就是把 OneDrive 的基线交给
 *   WebDAV 用，正是本模块要根除的故障。
 */
export function liftCloudBookView(
  raw: Readonly<Record<string, unknown>>,
  bookId: string,
): Record<string, unknown> {
  if (!isScopedCloudBookId(bookId)) {
    const view: Record<string, unknown> = { ...raw };
    delete view[CLOUD_BOOK_NAMESPACE_KEY];
    return view;
  }
  const view: Record<string, unknown> = {};
  const slice = readNamespaceSlice(raw, bookId);
  for (const [key, value] of Object.entries(raw)) {
    if (key === CLOUD_BOOK_NAMESPACE_KEY) continue;
    if (isCloudBookDataKey(key)) continue;
    view[key] = value;
  }
  for (const [key, value] of Object.entries(slice)) {
    view[key] = value;
  }
  return view;
}

/**
 * 把视图压回物理形状。
 *
 * OneDrive 写回顶层；其他账只写自己的命名空间条目，**顶层的 OneDrive 账一
 * 个字节都不碰**（切到 WebDAV 时 OneDrive 的基线必须原样留着，切回来才能
 * 恢复）。视图里缺席的账本键会被删掉，删除语义因此能落到盘上。
 */
export function pushCloudBookView(
  raw: Readonly<Record<string, unknown>>,
  view: Readonly<Record<string, unknown>>,
  bookId: string,
): Record<string, unknown> {
  if (!isScopedCloudBookId(bookId)) {
    const next: Record<string, unknown> = { ...view };
    // 命名空间（别的账）必须原样保留。
    if (Object.prototype.hasOwnProperty.call(raw, CLOUD_BOOK_NAMESPACE_KEY)) {
      next[CLOUD_BOOK_NAMESPACE_KEY] = raw[CLOUD_BOOK_NAMESPACE_KEY];
    }
    for (const key of CLOUD_BOOK_DATA_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(view, key)) delete next[key];
    }
    return next;
  }
  const next: Record<string, unknown> = {};
  // 顶层账本键是 **OneDrive 的账**，必须原样留着——切到 WebDAV 之后它的
  // 基线还在原地等它切回来。这里若跳过账本键，写一次 WebDAV 配置就等于把
  // OneDrive 的账整本抹掉（`tests/cloud-book.test.ts` 用「值仍等于原值」钉住）。
  for (const [key, value] of Object.entries(raw)) next[key] = value;
  const slice: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view)) {
    if (!isCloudBookDataKey(key)) {
      next[key] = value;
      continue;
    }
    slice[key] = value;
  }
  const namespace = isRecord(raw[CLOUD_BOOK_NAMESPACE_KEY])
    ? { ...raw[CLOUD_BOOK_NAMESPACE_KEY] }
    : {};
  next[CLOUD_BOOK_NAMESPACE_KEY] = { ...namespace, [bookId]: slice };
  return next;
}

function readNamespaceSlice(
  raw: Readonly<Record<string, unknown>>,
  bookId: string,
): Readonly<Record<string, unknown>> {
  const namespace = raw[CLOUD_BOOK_NAMESPACE_KEY];
  if (!isRecord(namespace)) return {};
  const slice = namespace[bookId];
  return isRecord(slice) ? slice : {};
}

/**
 * 当前活动的是哪一本账，只看 `data.json` 里那两个**跟设备走**的云端字段。
 *
 * 这两个字段刻意不参与分账（否则读不出自己该读哪一本）：云端身份是设备
 * 事实，账本身份由它派生。
 *
 * 坐标不全时退回 OneDrive：与 `readCloudSettings` 的 fail-closed 口径一致，
 * 绝不因为一条坏配置就去开一本谁也不认识的账。
 */
export function resolveActiveCloudBookId(
  raw: Readonly<Record<string, unknown>>,
  keys: { readonly provider: string; readonly webdav: string },
): string {
  const settings = readCloudSettings(raw, keys);
  if (settings.provider !== "webdav" || !settings.webdav) {
    return CLOUD_BOOK_ONEDRIVE;
  }
  return webDavBookIdFromCoordinates(settings.webdav.coordinates);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
