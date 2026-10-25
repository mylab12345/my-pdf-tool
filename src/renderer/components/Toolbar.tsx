import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  ChevronDown,
  Eraser,
  FileDown,
  FilePlus2,
  FolderOpen,
  Highlighter,
  Lock,
  Maximize,
  PenTool,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  ScanText,
  Search,
  Settings,
  Signature,
  Square,
  PanelLeft,
  StickyNote,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useApp, useView, type ModalName, type ToolMode } from '../store';

/** Primary toolbar: file actions, history, zoom and the tool launcher. */
export function Toolbar(): ReactElement {
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] : undefined));
  const save = useApp((state) => state.save);
  const openDialog = useApp((state) => state.openDialog);
  const undo = useApp((state) => state.undo);
  const redo = useApp((state) => state.redo);
  const setModal = useApp((state) => state.setModal);
  const view = useView();
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!toolsOpen) return;
    const close = (event: MouseEvent): void => {
      if (!toolsRef.current?.contains(event.target as Node)) setToolsOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [toolsOpen]);

  const summary = entry?.summary;
  const [zoomText, setZoomText] = useState('');

  useEffect(() => {
    setZoomText(`${Math.round(view.zoom * 100)}%`);
  }, [view.zoom]);

  const openTool = (modal: ModalName): void => {
    setToolsOpen(false);
    setModal(modal);
  };

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <button type="button" className="icon-button" title="Open PDF (Ctrl+O)" onClick={() => void openDialog()}>
          <FolderOpen size={17} />
        </button>
        <button type="button" className="icon-button" title="New PDF (Ctrl+N)" onClick={() => setModal('newDocument')}>
          <FilePlus2 size={17} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Save (Ctrl+S)"
          disabled={!summary}
          onClick={() => void save(undefined, false)}
        >
          <Save size={17} />
        </button>
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          className="icon-button"
          title={summary?.undoLabel ? `Undo ${summary.undoLabel}` : 'Undo (Ctrl+Z)'}
          disabled={!summary?.canUndo}
          onClick={() => void undo()}
        >
          <Undo2 size={17} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={summary?.redoLabel ? `Redo ${summary.redoLabel}` : 'Redo (Ctrl+Shift+Z)'}
          disabled={!summary?.canRedo}
          onClick={() => void redo()}
        >
          <Redo2 size={17} />
        </button>
      </div>

      <div className="doc-title">
        <strong title={summary?.path ?? undefined}>{summary?.name ?? 'No document open'}</strong>
        <span>
          {summary
            ? `${summary.pageCount} page${summary.pageCount === 1 ? '' : 's'}${summary.dirty ? ' · unsaved changes' : ''}${
                summary.encrypted ? ' · encrypted' : ''
              }`
            : 'Drop a PDF here to begin'}
        </span>
      </div>

      <div className="toolbar-spacer" />

      {summary ? (
        <>
          <div className="toolbar-group">
            <button type="button" className="icon-button" title="Zoom out (Ctrl+-)" onClick={() => view.zoomBy(1 / 1.15)}>
              <ZoomOut size={17} />
            </button>
            <input
              className="zoom-field"
              aria-label="Zoom level"
              value={zoomText}
              onChange={(event) => setZoomText(event.target.value)}
              onBlur={() => {
                const parsed = Number.parseFloat(zoomText.replace('%', ''));
                if (Number.isFinite(parsed)) view.setZoom(parsed / 100);
                else setZoomText(`${Math.round(view.zoom * 100)}%`);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
              }}
            />
            <button type="button" className="icon-button" title="Zoom in (Ctrl+=)" onClick={() => view.zoomBy(1.15)}>
              <ZoomIn size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-pressed={view.fit === 'width'}
              title="Fit width (Ctrl+1)"
              onClick={() => view.setFit('width')}
            >
              <PanelLeft size={17} style={{ transform: 'rotate(90deg)' }} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-pressed={view.fit === 'page'}
              title="Fit page (Ctrl+0)"
              onClick={() => view.setFit('page')}
            >
              <Maximize size={17} />
            </button>
          </div>

          <div className="toolbar-group">
            <button
              type="button"
              className="icon-button"
              title="Rotate page left"
              onClick={() => void useApp.getState().apply([{ kind: 'rotatePages', pages: [view.currentPage], degrees: 90 }])}
            >
              <RotateCcw size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="Rotate page right"
              onClick={() => void useApp.getState().apply([{ kind: 'rotatePages', pages: [view.currentPage], degrees: -90 }])}
            >
              <RotateCw size={17} />
            </button>
          </div>

          <div className="toolbar-group">
            <button type="button" className="icon-button" title="Search (Ctrl+F)" onClick={() => view.setTab('search')}>
              <Search size={17} />
            </button>
            <button type="button" className="icon-button" title="Print (Ctrl+P)" onClick={() => setModal('print')}>
              <Printer size={17} />
            </button>
          </div>
        </>
      ) : null}

      <div className="toolbar-group" ref={toolsRef} style={{ position: 'relative' }}>
        <button type="button" className="icon-button wide" onClick={() => setToolsOpen((open) => !open)} aria-expanded={toolsOpen}>
          Tools <ChevronDown size={14} />
        </button>
        {toolsOpen ? (
          <div
            className="modal"
            style={{ position: 'absolute', right: 0, top: 38, width: 268, maxHeight: '70vh', zIndex: 70 }}
            role="menu"
          >
            <div className="body" style={{ padding: 8, gap: 2 }}>
              <ToolMenuItem icon={<ScanText size={15} />} label="OCR — recognise text" onClick={() => openTool('ocr')} />
              <ToolMenuItem icon={<FileDown size={15} />} label="Compress" onClick={() => openTool('compress')} />
              <ToolMenuItem icon={<Lock size={15} />} label="Encrypt / permissions" onClick={() => openTool('encrypt')} />
              <ToolMenuItem icon={<Signature size={15} />} label="Sign" onClick={() => openTool('sign')} />
              <ToolMenuItem icon={<Eraser size={15} />} label="Redact" onClick={() => openTool('redact')} />
              <ToolMenuItem icon={<Type size={15} />} label="Watermark" onClick={() => openTool('watermark')} />
              <ToolMenuItem icon={<Type size={15} />} label="Header & footer" onClick={() => openTool('headerFooter')} />
              <ToolMenuItem icon={<FileDown size={15} />} label="Convert / export" onClick={() => openTool('convert')} />
              <ToolMenuItem icon={<Search size={15} />} label="Forms" onClick={() => openTool('forms')} />
              <ToolMenuItem icon={<FileDown size={15} />} label="Split" onClick={() => openTool('split')} />
              <ToolMenuItem icon={<FilePlus2 size={15} />} label="Merge documents" onClick={() => openTool('merge')} />
              <ToolMenuItem icon={<StickyNote size={15} />} label="Metadata & outline" onClick={() => openTool('metadata')} />
              <ToolMenuItem icon={<FileDown size={15} />} label="Attachments" onClick={() => openTool('attachments')} />
              <ToolMenuItem icon={<Settings size={15} />} label="Settings" onClick={() => openTool('settings')} />
            </div>
          </div>
        ) : null}
      </div>

      <div className="toolbar-group">
        <button
          type="button"
          className="icon-button"
          aria-pressed={view.sidebarOpen}
          title="Toggle sidebar (Ctrl+B)"
          onClick={() => view.toggleSidebar()}
        >
          <PanelLeft size={17} />
        </button>
      </div>
    </header>
  );
}

function ToolMenuItem(props: { icon: React.ReactNode; label: string; onClick(): void }): ReactElement {
  return (
    <button
      type="button"
      className="outline-item"
      role="menuitem"
      onClick={props.onClick}
      style={{ justifyContent: 'flex-start', gap: 9, padding: '7px 9px' }}
    >
      <span className="muted" style={{ display: 'inline-flex' }}>
        {props.icon}
      </span>
      <span>{props.label}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Annotation palette                                                          */
/* -------------------------------------------------------------------------- */

const TOOLS: { mode: ToolMode; label: string; icon: ReactElement; hint: string }[] = [
  { mode: 'select', label: 'Select', icon: <PenTool size={15} />, hint: 'Select and move annotations (V)' },
  { mode: 'highlight', label: 'Highlight', icon: <Highlighter size={15} />, hint: 'Drag over text to highlight (H)' },
  { mode: 'underline', label: 'Underline', icon: <Type size={15} />, hint: 'Underline a region (U)' },
  { mode: 'strikeout', label: 'Strike out', icon: <Type size={15} />, hint: 'Strike through a region (S)' },
  { mode: 'ink', label: 'Draw', icon: <PenTool size={15} />, hint: 'Freehand drawing (D)' },
  { mode: 'square', label: 'Rectangle', icon: <Square size={15} />, hint: 'Draw a rectangle (R)' },
  { mode: 'note', label: 'Note', icon: <StickyNote size={15} />, hint: 'Place a sticky note (N)' },
  { mode: 'freetext', label: 'Text box', icon: <Type size={15} />, hint: 'Add a text box (T)' },
  { mode: 'redact', label: 'Mark for redaction', icon: <Eraser size={15} />, hint: 'Mark areas to remove permanently (X)' },
];

const COLORS = ['#f5c542', '#ff6b81', '#4ade80', '#60a5fa', '#a78bfa', '#111111', '#ffffff'];

export function AnnotationBar(): ReactElement | null {
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] : undefined));
  const view = useView();
  const apply = useApp((state) => state.apply);
  const selected = view.selectedAnnotation;
  if (!entry) return null;

  return (
    <div className="toolbar" style={{ height: 42, paddingLeft: 10, background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}>
      <div className="toolbar-group" style={{ paddingLeft: 0 }}>
        {TOOLS.map((tool) => (
          <button
            key={tool.mode}
            type="button"
            className="icon-button"
            aria-pressed={view.tool === tool.mode}
            title={tool.hint}
            onClick={() => view.setTool(tool.mode)}
          >
            {tool.icon}
          </button>
        ))}
      </div>

      <div className="toolbar-group">
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Colour ${color}`}
            title={`Colour ${color}`}
            onClick={() => view.setStyle({ color })}
            style={{
              width: 18,
              height: 18,
              borderRadius: 999,
              border: view.color === color ? '2px solid var(--accent)' : '1px solid var(--border-strong)',
              background: color,
              padding: 0,
            }}
          />
        ))}
        <input
          type="color"
          value={view.color}
          onChange={(event) => view.setStyle({ color: event.target.value })}
          title="Custom colour"
          style={{ width: 26, height: 22, marginLeft: 4 }}
        />
      </div>

      <div className="toolbar-group row" style={{ gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        <label className="row" style={{ gap: 5 }} title="Stroke width">
          W
          <input
            type="range"
            min={1}
            max={12}
            value={view.strokeWidth}
            onChange={(event) => view.setStyle({ strokeWidth: Number(event.target.value) })}
            style={{ width: 70 }}
          />
        </label>
        <label className="row" style={{ gap: 5 }} title="Opacity">
          O
          <input
            type="range"
            min={10}
            max={100}
            value={Math.round(view.opacity * 100)}
            onChange={(event) => view.setStyle({ opacity: Number(event.target.value) / 100 })}
            style={{ width: 70 }}
          />
        </label>
      </div>

      <div className="toolbar-spacer" />

      <button
        type="button"
        className="icon-button wide danger"
        disabled={!selected}
        title="Delete the selected annotation (Delete)"
        onClick={() => {
          if (!selected) return;
          void apply([{ kind: 'removeAnnotation', id: selected }]);
          view.selectAnnotation(null);
        }}
      >
        Delete annotation
      </button>
    </div>
  );
}
