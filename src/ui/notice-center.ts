import { Notice } from "obsidian";
import {
  compatClearTimeout,
  compatSetTimeout,
  type TimeoutHandle,
} from "../obsidian-compat";

export const NOTICE_PRIORITY = {
  info: 10,
  progress: 20,
  action: 30,
  attention: 40,
  failure: 50,
  critical: 60,
} as const;

export type EasySyncNoticeMessage = string | DocumentFragment;

/**
 * Notice category declared by call sites. Only `ambient` requests participate
 * in the user-configurable notification-popups level filter; `safety` and the
 * default (feedback) always display.
 */
export type EasySyncNoticeCategory = "ambient" | "safety";

/** User-facing notification popups level (per-device, persisted in data.json). */
export type EasySyncNotificationPopupsLevel = "all" | "important" | "off";

export interface EasySyncNoticeHandle {
  noticeEl?: HTMLElement;
  messageEl?: HTMLElement;
  setMessage(message: EasySyncNoticeMessage): unknown;
  hide(): void;
}

export interface EasySyncNoticeRequest {
  key: string;
  message: EasySyncNoticeMessage | (() => EasySyncNoticeMessage);
  priority: number;
  /** Zero keeps the notice visible until it is replaced or cleared. */
  durationMs?: number;
  className?: string;
  /** Keep the latest request so it can return after a short preemption. */
  resumable?: boolean;
  /**
   * `"ambient"`: sync-lifecycle notices filtered by the popups level;
   * `"safety"`: critical reminders that must always show; absent: feedback
   * (click results) that always shows.
   */
  category?: EasySyncNoticeCategory;
}

export type EasySyncNoticeFactory = (
  message: EasySyncNoticeMessage,
  durationMs: number,
) => EasySyncNoticeHandle;

interface ActiveNotice {
  request: EasySyncNoticeRequest;
  handle: EasySyncNoticeHandle;
}

const DEFAULT_NOTICE_DURATION_MS = 5_000;

/**
 * Thin display mutex for EasySync floating notices.
 *
 * Callers retain ownership of wording, rendering, duration and business state.
 * This class only owns the single visible slot, priority, deduplication,
 * expiration and restoration of a resumable progress notice.
 */
export class EasySyncNoticeCenter {
  private active: ActiveNotice | null = null;
  private expiryTimer: TimeoutHandle | null = null;
  private resumable: EasySyncNoticeRequest | null = null;
  private notificationPopups: EasySyncNotificationPopupsLevel;

  constructor(
    private readonly factory: EasySyncNoticeFactory = (message, durationMs) =>
      new Notice(message, durationMs),
    initialNotificationPopups: EasySyncNotificationPopupsLevel = "all",
  ) {
    this.notificationPopups = initialNotificationPopups;
  }

  get activeKey(): string | null {
    return this.active?.request.key ?? null;
  }

  /**
   * Change the notification popups level. An active ambient request that no
   * longer qualifies is hidden immediately; a stored resumable ambient request
   * that no longer qualifies is dropped so it cannot resurface after the next
   * preempting notice expires.
   */
  setNotificationPopups(level: EasySyncNotificationPopupsLevel): void {
    this.notificationPopups = level;
    if (this.active && !this.isAmbientAllowed(this.active.request)) {
      this.hideActive();
    }
    if (this.resumable && !this.isAmbientAllowed(this.resumable)) {
      this.resumable = null;
    }
  }

  show(request: EasySyncNoticeRequest): boolean {
    // Filter ambient requests before any slot or resumable state is touched:
    // a rejected request never occupies the slot and never restores.
    if (!this.isAmbientAllowed(request)) return false;
    const normalized = { ...request };
    if (normalized.resumable) this.resumable = normalized;

    if (this.active?.request.key === normalized.key) {
      const previousClassName = this.active.request.className;
      this.active.request = normalized;
      this.applyClasses(this.active.handle, normalized.className, previousClassName);
      this.active.handle.setMessage(this.materialize(normalized.message));
      this.scheduleExpiry(normalized);
      return true;
    }

    if (this.active && normalized.priority < this.active.request.priority) {
      return false;
    }

    this.hideActive();
    this.display(normalized);
    return true;
  }

  clear(key: string): void {
    if (this.resumable?.key === key) this.resumable = null;
    if (this.active?.request.key === key) this.hideActive();
  }

  dispose(): void {
    this.resumable = null;
    this.hideActive();
  }

  private isAmbientAllowed(request: EasySyncNoticeRequest): boolean {
    if (request.category !== "ambient") return true;
    switch (this.notificationPopups) {
      case "off":
        return false;
      case "important":
        return request.priority >= NOTICE_PRIORITY.attention;
      default:
        return true;
    }
  }

  private display(request: EasySyncNoticeRequest): void {
    const handle = this.factory(this.materialize(request.message), 0);
    this.applyClasses(handle, request.className);
    this.active = { request, handle };
    this.scheduleExpiry(request);
  }

  private materialize(
    message: EasySyncNoticeRequest["message"],
  ): EasySyncNoticeMessage {
    return typeof message === "function" ? message() : message;
  }

  private applyClasses(
    handle: EasySyncNoticeHandle,
    className?: string,
    previousClassName?: string,
  ): void {
    const element = handle.noticeEl ?? handle.messageEl;
    if (!element) return;
    element.classList.add("easy-sync-notice");
    if (previousClassName && previousClassName !== className) {
      element.classList.remove(previousClassName);
    }
    if (className) element.classList.add(className);
  }

  private scheduleExpiry(request: EasySyncNoticeRequest): void {
    compatClearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const durationMs = request.durationMs ?? DEFAULT_NOTICE_DURATION_MS;
    if (durationMs <= 0) return;
    this.expiryTimer = compatSetTimeout(() => {
      this.expiryTimer = null;
      const expiredKey = this.active?.request.key;
      this.hideActive();
      if (this.resumable && this.resumable.key !== expiredKey) {
        this.display(this.resumable);
      }
    }, durationMs);
  }

  private hideActive(): void {
    compatClearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.active) {
      this.hideImmediately(this.active.handle);
      this.active.handle.hide();
    }
    this.active = null;
  }

  /**
   * Obsidian keeps a hidden Notice in the DOM briefly for its exit animation.
   * Collapse the old host before creating the replacement so two EasySync
   * messages never compete visually during that transition.
   */
  private hideImmediately(handle: EasySyncNoticeHandle): void {
    const element = handle.noticeEl ?? handle.messageEl;
    if (!element) return;
    element.classList.add("easy-sync-notice-hidden");
    const host = typeof element.closest === "function"
      ? element.closest<HTMLElement>(".notice")
      : null;
    if (host && host !== element) host.classList.add("easy-sync-notice-hidden");
  }
}
