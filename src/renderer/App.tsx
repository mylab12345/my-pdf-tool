import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { MenuCommand } from '../shared/ipc';
import { AnnotationBar, Toolbar } from './components/Toolbar';
import { Sidebar } from './components/Sidebar';
import { Viewer } from './components/Viewer';
import { Modals } from './components/Modals';
import { DropOverlay, StatusBar, TaskStrip, Toasts } from './components/Chrome';
import { api } from './lib/bridge';
import { useApp, useView } from './store';

/**
 * Application shell.
 *
 * Owns the global wiring that is not tied to a single component: theme, the
 * main-process event stream (menu commands, file associations, task progress,
 * document changes, crash recovery), keyboard shortcuts and drag and drop.
 */
export function App(): ReactElement {
  const init = useApp((state) => state.init);
  const ready = useApp((state) => state.ready);
  const settings = useApp((state) => state.settings);
  const activeId = useApp((state) => state.activeId);
  const setModal = useApp((state) => state.setModal);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    void init();
  }, [init]);

  /* Theme ------------------------------------------------------------------ */
  useEffect(() => {
    const root = document.documentElement;
    const apply = (): void => {
      const preference = settings?.theme ?? 'system';
      const dark =
        preference === 'dark' ||
        (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    root.style.setProperty('--accent', settings?.accent ?? '#3b6ef6');
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings?.theme, settings?.accent]);

  /* Main-process events ----------------------------------------------------- */
  useEffect(() => {
    const disposers: (() => void)[] = [];

    disposers.push(
      api.app.onMenuCommand((command: MenuCommand) => {
        const app = useApp.getState();
        const view = useView.getState();
        switch (command) {
          case 'file:new':
            return app.setModal('newDocument');
          case 'file:open':
            void app.openDialog();
            return;
          case 'file:save':
            void app.save();
            return;
          case 'file:saveAs':
            void app.save(undefined, true);
            return;
          case 'file:print':
            return app.setModal('print');
          case 'file:close':
            if (app.activeId) void app.close(app.activeId);
            return;
          case 'edit:undo':
            void app.undo();
            return;
          case 'edit:redo':
            void app.redo();
            return;
          case 'edit:find':
            view.setTab('search');
            return;
          case 'edit:delete-annotations': {
            const selected = view.selectedAnnotation;
            if (selected) {
              void app.apply([{ kind: 'removeAnnotation', id: selected }]);
              view.selectAnnotation(null);
            }
            return;
          }
          case 'view:zoom-in':
            return view.zoomBy(1.15);
          case 'view:zoom-out':
            return view.zoomBy(1 / 1.15);
          case 'view:fit-width':
            return view.setFit('width');
          case 'view:fit-page':
            return view.setFit('page');
          case 'view:rotate-left':
            void app.apply([{ kind: 'rotatePages', pages: [view.currentPage], degrees: 90 }]);
            return;
          case 'view:rotate-right':
            void app.apply([{ kind: 'rotatePages', pages: [view.currentPage], degrees: -90 }]);
            return;
          case 'view:sidebar':
            return view.toggleSidebar();
          case 'tools:ocr':
            return app.setModal('ocr');
          case 'tools:compress':
            return app.setModal('compress');
          case 'tools:encrypt':
            return app.setModal('encrypt');
          case 'tools:convert':
            return app.setModal('convert');
          case 'tools:sign':
            return app.setModal('sign');
          case 'tools:redact':
            return app.setModal('redact');
          case 'tools:watermark':
            return app.setModal('watermark');
          case 'tools:forms':
            return app.setModal('forms');
          case 'tools:merge':
            return app.setModal('merge');
          case 'tools:split':
            return app.setModal('split');
          case 'tools:settings':
            return app.setModal('settings');
          case 'help:shortcuts':
            return app.setModal('shortcuts');
          case 'help:about':
            return app.setModal('about');
          default:
            return;
        }
      }),
    );

    disposers.push(
      api.app.onOpenFile((request) => {
        for (const path of request.paths) void useApp.getState().openPath(path);
      }),
    );

    disposers.push(
      api.app.onTaskProgress((progress) => {
        const app = useApp.getState();
        if (progress.percent >= 100) {
          setTimeout(() => app.clearTask(progress.taskId), 600);
        } else {
          app.setTask(progress);
        }
      }),
    );

    disposers.push(
      api.app.onDocumentChanged((event) => {
        // The main process bumps a revision; refresh the cached copy.
        void useApp.getState().refresh(event.id);
      }),
    );

    disposers.push(
      api.app.onRecoveryAvailable((files) => {
        if (!files.length) return;
        useApp.getState().setModal('recovery');
      }),
    );

    return () => {
      for (const dispose of disposers) dispose();
    };
  }, []);

  /* Keyboard shortcuts ------------------------------------------------------ */
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const app = useApp.getState();
      const view = useView.getState();
      const mod = event.ctrlKey || event.metaKey;

      if (mod && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        void app.openDialog();
        return;
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void app.save(undefined, event.shiftKey);
        return;
      }
      if (mod && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        app.setModal('newDocument');
        return;
      }
      if (mod && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        app.setModal('print');
        return;
      }
      if (mod && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        view.setTab('search');
        return;
      }
      if (mod && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        view.toggleSidebar();
        return;
      }
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) void app.redo();
        else void app.undo();
        return;
      }
      if (mod && (event.key === '+' || event.key === '=')) {
        event.preventDefault();
        view.zoomBy(1.15);
        return;
      }
      if (mod && event.key === '-') {
        event.preventDefault();
        view.zoomBy(1 / 1.15);
        return;
      }
      if (mod && event.key === '1') {
        event.preventDefault();
        view.setFit('width');
        return;
      }
      if (mod && event.key === '0') {
        event.preventDefault();
        view.setFit('page');
        return;
      }
      if (typing) return;

      if (event.key === 'Escape') {
        view.setTool('select');
        view.selectAnnotation(null);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (view.selectedAnnotation) {
          event.preventDefault();
          void app.apply([{ kind: 'removeAnnotation', id: view.selectedAnnotation }]);
          view.selectAnnotation(null);
        }
        return;
      }
      if (event.key === 'PageDown') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('arena:go-to-page', { detail: { pageIndex: Math.min(view.pageCount - 1, view.currentPage + 1) } }));
        return;
      }
      if (event.key === 'PageUp') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('arena:go-to-page', { detail: { pageIndex: Math.max(0, view.currentPage - 1) } }));
        return;
      }

      const tools: Record<string, Parameters<typeof view.setTool>[0]> = {
        v: 'select',
        h: 'highlight',
        u: 'underline',
        s: 'strikeout',
        d: 'ink',
        r: 'square',
        n: 'note',
        t: 'freetext',
        x: 'redact',
      };
      const tool = tools[event.key.toLowerCase()];
      if (tool && !mod && !event.altKey) view.setTool(tool);
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  /* Drag and drop ----------------------------------------------------------- */
  const openDropped = useCallback(async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith('.pdf')) continue;
      const path = api.dragDropPath(file);
      if (path) await useApp.getState().openPath(path);
      else useApp.getState().toast('error', 'Could not read the dropped file', file.name);
    }
  }, []);

  useEffect(() => {
    const onDragEnter = (event: DragEvent): void => {
      event.preventDefault();
      dragDepth.current += 1;
      if (event.dataTransfer?.types.includes('Files')) setDragging(true);
    };
    const onDragOver = (event: DragEvent): void => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent): void => {
      event.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void openDropped(event.dataTransfer?.files ?? null);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [openDropped]);

  return (
    <div className="app" data-ready={ready}>
      <Toolbar />
      <AnnotationBar />
      <div className="app-body">
        <Sidebar />
        <main className="workspace">
          <Viewer key={activeId ?? 'empty'} />
          <StatusBar />
        </main>
      </div>
      <Modals />
      <Toasts />
      <TaskStrip />
      <DropOverlay visible={dragging} />
    </div>
  );
}
