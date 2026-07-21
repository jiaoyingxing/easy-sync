import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EasySyncNoticeCenter,
  NOTICE_PRIORITY,
  type EasySyncNoticeHandle,
} from "../src/ui/notice-center";

class FakeClassList {
  readonly values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) this.values.add(token);
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) this.values.delete(token);
  }
}

class FakeNotice implements EasySyncNoticeHandle {
  readonly hostDisplay: string[] = [];
  readonly messageDisplay: string[] = [];
  readonly noticeEl = {
    classList: new FakeClassList(),
    style: { setProperty: (_name: string, value: string) => this.messageDisplay.push(value) },
    closest: () => ({
      style: { setProperty: (_name: string, value: string) => this.hostDisplay.push(value) },
    }),
  } as unknown as HTMLElement;
  readonly messages: Array<string | DocumentFragment>;
  hidden = false;

  constructor(message: string | DocumentFragment) {
    this.messages = [message];
  }

  setMessage(message: string | DocumentFragment): this {
    this.messages.push(message);
    return this;
  }

  hide(): void {
    this.hidden = true;
  }
}

describe("EasySyncNoticeCenter", () => {
  const created: FakeNotice[] = [];
  let center: EasySyncNoticeCenter;

  beforeEach(() => {
    vi.useFakeTimers();
    created.length = 0;
    center = new EasySyncNoticeCenter((message) => {
      const notice = new FakeNotice(message);
      created.push(notice);
      return notice;
    });
  });

  afterEach(() => {
    center.dispose();
    vi.useRealTimers();
  });

  it("updates the same event in place instead of creating duplicate notices", () => {
    center.show({
      key: "sync-progress",
      message: "1/3",
      priority: NOTICE_PRIORITY.progress,
      durationMs: 0,
      resumable: true,
    });
    center.show({
      key: "sync-progress",
      message: "2/3",
      priority: NOTICE_PRIORITY.progress,
      durationMs: 0,
      resumable: true,
    });

    expect(created).toHaveLength(1);
    expect(created[0].messages).toEqual(["1/3", "2/3"]);
  });

  it("lets higher priority replace the active notice and drops lower priority work", () => {
    expect(center.show({
      key: "sync-progress",
      message: "progress",
      priority: NOTICE_PRIORITY.progress,
      durationMs: 0,
    })).toBe(true);
    expect(center.show({
      key: "sync-failed",
      message: "failed",
      priority: NOTICE_PRIORITY.failure,
      durationMs: 2_000,
    })).toBe(true);
    expect(center.show({
      key: "sync-complete",
      message: "complete",
      priority: NOTICE_PRIORITY.info,
      durationMs: 2_000,
    })).toBe(false);

    expect(created).toHaveLength(2);
    expect(created[0].hidden).toBe(true);
    expect(created[0].messageDisplay).toEqual(["none"]);
    expect(created[0].hostDisplay).toEqual(["none"]);
    expect(created[1].messages).toEqual(["failed"]);
  });

  it("lets the latest notice replace another event at the same priority", () => {
    center.show({
      key: "conflict:first.md",
      message: "first",
      priority: NOTICE_PRIORITY.action,
      durationMs: 2_000,
    });
    center.show({
      key: "conflict:second.md",
      message: "second",
      priority: NOTICE_PRIORITY.action,
      durationMs: 2_000,
    });

    expect(created).toHaveLength(2);
    expect(created[0].hidden).toBe(true);
    expect(created[1].messages).toEqual(["second"]);
  });

  it("restores the latest resumable progress after a short higher-priority notice", () => {
    center.show({
      key: "sync-progress",
      message: "1/3",
      priority: NOTICE_PRIORITY.progress,
      durationMs: 0,
      resumable: true,
    });
    center.show({
      key: "action-result",
      message: "saved",
      priority: NOTICE_PRIORITY.action,
      durationMs: 2_000,
    });
    expect(center.show({
      key: "sync-progress",
      message: "2/3",
      priority: NOTICE_PRIORITY.progress,
      durationMs: 0,
      resumable: true,
    })).toBe(false);

    vi.advanceTimersByTime(2_000);

    expect(created).toHaveLength(3);
    expect(created[1].hidden).toBe(true);
    expect(created[2].messages).toEqual(["2/3"]);
  });

  it("does not queue stale lower-priority notices", () => {
    center.show({
      key: "sync-failed",
      message: "failed",
      priority: NOTICE_PRIORITY.failure,
      durationMs: 2_000,
    });
    center.show({
      key: "settings-saved",
      message: "saved",
      priority: NOTICE_PRIORITY.info,
      durationMs: 2_000,
    });

    vi.advanceTimersByTime(2_000);

    expect(created).toHaveLength(1);
    expect(created[0].hidden).toBe(true);
    expect(center.activeKey).toBeNull();
  });

  it("clears resumable progress so terminal results cannot revive it", () => {
    center.show({
      key: "sync-progress",
      message: "1/3",
      priority: NOTICE_PRIORITY.progress,
      durationMs: 0,
      resumable: true,
    });
    center.show({
      key: "sync-failed",
      message: "failed",
      priority: NOTICE_PRIORITY.failure,
      durationMs: 2_000,
    });
    center.clear("sync-progress");

    vi.advanceTimersByTime(2_000);

    expect(created).toHaveLength(2);
    expect(center.activeKey).toBeNull();
  });
});
