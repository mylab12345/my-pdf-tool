import type { ReactElement } from 'react';
import { AlertTriangle, CheckCircle2, Info, ShieldCheck, X } from 'lucide-react';
import { api } from '../lib/bridge';
import { useApp, useView } from '../store';

/** Status bar: where you are in the document plus the privacy reminder. */
export function StatusBar(): ReactElement {
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] : undefined));
  const docCount = useApp((state) => state.order.length);
  const view = useView();
  const annotations = entry?.annotations.length ?? 0;

  return (
    <footer className="statusbar">
      <span>{entry ? `Page ${view.currentPage + 1} of ${entry.summary.pageCount}` : 'No document'}</span>
      {entry ? <span>{Math.round(view.zoom * 100)}%</span> : null}
      {entry ? <span>{annotations} annotation{annotations === 1 ? '' : 's'}</span> : null}
      {entry?.summary.encrypted ? <span className="badge">encrypted</span> : null}
      {entry?.summary.dirty ? <span className="badge">unsaved</span> : null}
      <span className="spacer" />
      {docCount > 1 ? <span>{docCount} documents open</span> : null}
      <span className="badge accent row" style={{ gap: 4 }}>
        <ShieldCheck size={11} /> Local &amp; offline
      </span>
      <span>v{useApp.getState().environment?.appVersion ?? '1.0.0'}</span>
    </footer>
  );
}

/** Bottom-right task strip with progress and cancellation. */
export function TaskStrip(): ReactElement | null {
  const tasks = useApp((state) => state.tasks);
  const clearTask = useApp((state) => state.clearTask);
  const entries = Object.values(tasks);
  if (!entries.length) return null;

  return (
    <div className="task-strip">
      {entries.map((task) => (
        <div key={task.taskId} className="task-card">
          <header>
            <span>{task.label}</span>
            {task.cancellable ? (
              <button
                type="button"
                className="icon-button"
                title="Cancel"
                style={{ width: 22, height: 22 }}
                onClick={async () => {
                  await api.app.cancelTask(task.taskId);
                  clearTask(task.taskId);
                }}
              >
                <X size={13} />
              </button>
            ) : null}
          </header>
          <div className="progress">
            <div style={{ width: `${task.percent}%` }} />
          </div>
          <div className="row between" style={{ marginTop: 5 }}>
            <small>{task.phase ?? ''}</small>
            <small>
              {task.completed}/{task.total} · {task.percent}%
            </small>
          </div>
        </div>
      ))}
    </div>
  );
}

export function Toasts(): ReactElement {
  const toasts = useApp((state) => state.toasts);
  const dismiss = useApp((state) => state.dismissToast);

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <span style={{ marginTop: 1 }}>
            {toast.kind === 'error' ? <AlertTriangle size={15} /> : toast.kind === 'success' ? <CheckCircle2 size={15} /> : <Info size={15} />}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{toast.title}</strong>
            {toast.message ? <p>{toast.message}</p> : null}
          </div>
          <button type="button" className="icon-button" style={{ width: 20, height: 20 }} onClick={() => dismiss(toast.id)} title="Dismiss">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function DropOverlay(props: { visible: boolean }): ReactElement | null {
  if (!props.visible) return null;
  return <div className="dropzone">Drop PDF files to open them</div>;
}
