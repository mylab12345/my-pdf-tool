import type { TaskProgress } from '../shared/ipc';

/**
 * Progress reporting and cancellation for long running tasks.
 *
 * The renderer generates a task id, passes it with the request and subscribes to
 * progress events; cancelling sets a flag the engines poll between pages.
 */
export class TaskManager {
  private readonly cancelled = new Set<string>();
  private readonly labels = new Map<string, string>();

  constructor(private readonly emit: (progress: TaskProgress) => void) {}

  begin(taskId: string | undefined, label: string, total: number, cancellable = true): {
    update: (completed: number, total?: number, label?: string, phase?: string) => void;
    shouldCancel: () => boolean;
    finish: () => void;
    id: string;
  } {
    const id = taskId ?? `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.labels.set(id, label);
    const report = (completed: number, totalCount = total, currentLabel = label, phase?: string) => {
      this.emit({
        taskId: id,
        label: currentLabel,
        ...(phase ? { phase } : {}),
        completed,
        total: totalCount,
        percent: totalCount > 0 ? Math.min(100, Math.round((completed / totalCount) * 100)) : 0,
        cancellable,
      });
    };
    report(0, total, label);
    return {
      id,
      update: (completed, totalCount, currentLabel, phase) => report(completed, totalCount ?? total, currentLabel ?? label, phase),
      shouldCancel: () => this.cancelled.has(id),
      finish: () => {
        this.labels.delete(id);
        this.cancelled.delete(id);
      },
    };
  }

  cancel(taskId: string): void {
    if (this.labels.has(taskId)) this.cancelled.add(taskId);
  }

  isCancelled(taskId: string | undefined): boolean {
    return taskId ? this.cancelled.has(taskId) : false;
  }
}
