/**
 * 片⑥ 模式切换的纯事实：两道告知弹框用的数量与手输字面量。
 *
 * 数量口径（报告单列）：
 * - 开启侧「改过、还没上传」＝切换后会被「留副本＋云端接管」处置的文件数：
 *   有基线且本机内容与基线不同，或没有基线但云端已有同名（这两种都会变成副本）。
 *   它需要一份**本机扫描事实**（在设置页动作里取一次，无网络）。
 * - 开启侧「待确认的云端删除」＝待确认删除行数（状态里现成）。
 * - 关闭侧「尚未上传」＝本机独有条目（片② 副本记录＋片④ 新建记录）总数，
 *   含被「不再提醒」忽略的那些。
 * - 关闭侧「其中不再提醒」＝上述条目里仍被忽略记忆命中的条数。
 */

import type {
  BaseFileEntry,
  LocalFileEntry,
  RemoteFileEntry,
} from "./types";
import {
  isLocalOnlyPathIgnored,
  type LocalOnlyIgnoreMemoryV1,
} from "./local-only-ignore-memory";
import type { LocalOnlyEntryRowV1 } from "./local-only-copies";
import { isExcludedFromOneWaySyncPath } from "./sync-direction";

/**
 * 开启侧「改过、还没上传」的计数：这些文件会在切换后变成副本。排除块（配置
 * 白名单含 `themes/`／`snippets/`、社区插件、自身构筑物）在模式内保持双向，不会
 * 变成副本，因此必须按同一条排除判定剔除——否则数字会高于实际处置量
 * （2026-10-12 review）。
 */
export function countLocalOnlyEditedFacts(input: {
  localEntries: readonly LocalFileEntry[];
  baseEntries: readonly BaseFileEntry[];
  remoteEntries: readonly RemoteFileEntry[];
  configDir: string;
  pluginId?: string;
}): number {
  const baseByPath = new Map(
    input.baseEntries.map((entry) => [entry.path, entry]),
  );
  const remotePaths = new Set(input.remoteEntries.map((entry) => entry.path));
  return input.localEntries.filter((local) => {
    if (isExcludedFromOneWaySyncPath(local.path, input.configDir, input.pluginId)) {
      return false;
    }
    const base = baseByPath.get(local.path);
    if (base) {
      return local.hash !== base.hash || local.size !== base.size;
    }
    // 无基线、云端已有同名：同样留副本（云端版本接管原路径）。
    return remotePaths.has(local.path);
  }).length;
}

export function countLocalOnlyRowFacts(input: {
  rows: readonly LocalOnlyEntryRowV1[];
  memory: LocalOnlyIgnoreMemoryV1 | null;
}): { total: number; dismissed: number } {
  return {
    total: input.rows.length,
    dismissed: input.rows.filter((row) =>
      isLocalOnlyPathIgnored(input.memory, row.targetPath)).length,
  };
}

/**
 * 门槛弹框要求的手输字面量——文案稿 `settings.syncMode.gate.inputLabel`
 * 引号内的那句话（中文「开启单向同步」／英文 "Turn on One-way sync"；2026-10-12
 * 末轮改为动作名本身，比"我确定"更难顺手打）。不新增用户可见字符串：它逐字
 * 取自已过目的提示句。
 */
export function syncModeGateInputLiteral(language: string): string {
  return language === "zh-cn" ? "开启单向同步" : "Turn on One-way sync";
}
