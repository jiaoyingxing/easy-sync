import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { AuthPendingModal } from "../src/ui/auth-pending-modal";
import type { AuthModule } from "../src/auth/auth-module";

function makeModal(loggedIn: boolean, show: ReturnType<typeof vi.fn>) {
  const auth = {
    authState: { isLoggedIn: loggedIn },
  } as unknown as AuthModule;
  const modal = new AuthPendingModal(
    {} as never,
    "pending-title",
    "pending-message",
    "复制登录链接",
    "重新打开登录页面",
    "取消登录",
    undefined,
    undefined,
    {
      auth,
      noticeCenter: { show },
      t: ((key: string) => key) as never,
    },
  );
  return modal;
}

describe("AuthPendingModal auto-completion", () => {
  it("auto-closes with a success notice once login completes — no manual recheck", async () => {
    const show = vi.fn();
    const modal = makeModal(true, show);
    let settled: { action: string } | null = null;
    void modal.awaitAction().then((result) => {
      settled = result;
    });

    (modal as unknown as { onAuthTick: () => void }).onAuthTick();
    await Promise.resolve();

    expect(show).toHaveBeenCalledWith(expect.objectContaining({
      key: "settings-login-success",
    }));
    expect(settled).toEqual({ action: "dismiss" });
  });

  it("keeps waiting while the redirect has not landed", async () => {
    const show = vi.fn();
    const modal = makeModal(false, show);
    let settled: { action: string } | null = null;
    void modal.awaitAction().then((result) => {
      settled = result;
    });

    (modal as unknown as { onAuthTick: () => void }).onAuthTick();
    await Promise.resolve();

    expect(show).not.toHaveBeenCalled();
    expect(settled).toBeNull();
  });

  it("removes the manual recheck affordance and wires the state tick", () => {
    const source = readFileSync("src/ui/auth-pending-modal.ts", "utf8");
    expect(source).not.toContain("recheck");
    expect(source).not.toContain("settings.account.recheck");
    expect(source).toContain("compatSetInterval");
    expect(source).toContain("compatClearInterval(this.authTick)");
  });
});
