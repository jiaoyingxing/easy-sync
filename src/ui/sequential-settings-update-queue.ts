export class SequentialSettingsUpdateQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(task: () => Promise<void>): Promise<void> {
    const current = this.tail.then(task);
    this.tail = current.catch(() => undefined);
    return current;
  }

  async whenIdle(): Promise<void> {
    let observedTail: Promise<void>;
    do {
      observedTail = this.tail;
      await observedTail;
    } while (observedTail !== this.tail);
  }
}
