/**
 * 测试环境补桩（vitest `setupFiles`；本仓无 jsdom，跑在 Node 环境上）。
 *
 * `MutationObserver`：设置页图标（`src/ui/settings-tab.ts` 构造期挂容器观察器，
 * 宿主重建根级导航行后补挂图标）在 Node 环境里没有该全局 ⇒ 补一个只记录调用的
 * 最小桩。桩不驱动回调：装饰器的 DOM 行为由真宿主证据承接
 * （docs/temp/20261017-162313 设置页图标方案单 §九）。
 */
class MutationObserverStub {
  constructor(_callback: () => void) {}

  observe(): void {}

  disconnect(): void {}

  takeRecords(): unknown[] {
    return [];
  }
}

const globals = globalThis as { MutationObserver?: unknown };
if (globals.MutationObserver === undefined) {
  globals.MutationObserver = MutationObserverStub;
}
