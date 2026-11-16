export interface ActiveFileProgress {
  path: string;
  startedAt: number;
}

/**
 * Keeps the UI pointed at the oldest file still being processed. This avoids
 * showing a completed file as "slow" when concurrent workers are indexing
 * different files.
 */
export class ActiveFileProgressTracker {
  private readonly active = new Map<string, ActiveFileProgress>();
  private readonly onChange: (current: ActiveFileProgress | null) => void;
  private readonly now: () => number;

  constructor(
    onChange: (current: ActiveFileProgress | null) => void,
    now: () => number = Date.now,
  ) {
    this.onChange = onChange;
    this.now = now;
  }

  start(workerKey: string, filePath: string): void {
    this.active.set(workerKey, { path: filePath, startedAt: this.now() });
    this.publish();
  }

  finish(workerKey: string): void {
    if (this.active.delete(workerKey)) this.publish();
  }

  private publish(): void {
    let oldest: ActiveFileProgress | null = null;
    for (const item of this.active.values()) {
      if (!oldest || item.startedAt < oldest.startedAt) oldest = item;
    }
    this.onChange(oldest);
  }
}
