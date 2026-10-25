import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Annotation, AnnotationInput, PageInfo, Rect } from '../../shared/types';
import { api, attempt } from '../lib/bridge';
import { buildTextSpans, loadPdf, renderPage, type PDFDocumentProxy, type PDFPageProxy, type TextSpan } from '../lib/pdf';
import { useApp, useView, type DocEntry } from '../store';
import { TextComposer } from './TextComposer';
import { WelcomeScreen } from './WelcomeScreen';

/**
 * The document canvas.
 *
 * Pages are laid out in a continuous column. Each page renders lazily (only
 * when it scrolls into view) at device pixel ratio, with a pdf.js text layer for
 * selection and an annotation layer for editing. Drawing happens in page-local
 * CSS pixels and is converted to PDF user space through the page viewport, so it
 * stays correct on rotated and oddly sized pages.
 */

interface PdfBundle {
  doc: PDFDocumentProxy;
  pages: Map<number, PDFPageProxy>;
}

function usePdfDocument(url: string | null): { bundle: PdfBundle | null; error: string | null } {
  const [bundle, setBundle] = useState<PdfBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setBundle(null);
      return;
    }
    let cancelled = false;
    setError(null);
    loadPdf(url)
      .then((doc) => {
        if (cancelled) return;
        setBundle({ doc, pages: new Map() });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return { bundle, error };
}

function rotatedSize(page: PageInfo): { width: number; height: number } {
  return page.rotation % 180 === 0 ? { width: page.width, height: page.height } : { width: page.height, height: page.width };
}

export function Viewer(): ReactElement {
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] ?? null : null));
  const loading = useApp((state) => !state.ready);
  const view = useView();
  const containerRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 900, height: 700 });
  const [composer, setComposer] = useState<{ pageIndex: number; rect: Rect; kind: 'note' | 'freetext' } | null>(null);
  const [visiblePage, setVisiblePage] = useState(0);

  const revision = entry?.revision ?? 0;
  const id = entry?.summary.id ?? null;

  // Ask the main process for the session URL on every revision bump; pdf.js then
  // reloads the bytes. The revision is part of the URL so nothing is stale.
  useEffect(() => {
    setUrl(null);
    if (!id) return;
    let cancelled = false;
    void attempt(api.documents.url(id)).then((next) => {
      if (cancelled) return;
      if (next) setUrl(next.includes('rev=') ? `${next}&r=${revision}` : `${next}?r=${revision}`);
    });
    return () => {
      cancelled = true;
    };
  }, [id, revision]);

  const { bundle, error } = usePdfDocument(url);
  const pages = entry?.info?.pages ?? [];

  useEffect(() => {
    useView.getState().setPageCount(pages.length);
  }, [pages.length]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setContainerSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    setContainerSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  const scale = useMemo(() => {
    if (!pages.length) return view.zoom;
    const widest = Math.max(...pages.map((page) => rotatedSize(page).width));
    const tallest = Math.max(...pages.map((page) => rotatedSize(page).height));
    if (view.fit === 'width') return Math.max(0.15, (containerSize.width - 56) / widest);
    if (view.fit === 'page') {
      return Math.max(0.15, Math.min((containerSize.width - 56) / widest, (containerSize.height - 60) / tallest));
    }
    return view.zoom;
  }, [pages, view.fit, view.zoom, containerSize]);

  const reportPage = useCallback((index: number) => {
    setVisiblePage(index);
    useView.getState().setCurrentPage(index);
  }, []);

  const scrollToPage = useCallback((index: number) => {
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(`[data-page-index="${index}"]`);
    if (target) container.scrollTo({ top: target.offsetTop - 24, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ pageIndex: number }>).detail;
      if (typeof detail?.pageIndex === 'number') scrollToPage(detail.pageIndex);
    };
    window.addEventListener('arena:go-to-page', handler);
    return () => window.removeEventListener('arena:go-to-page', handler);
  }, [scrollToPage]);

  if (!entry) {
    return loading ? <div className="viewer" /> : <WelcomeScreen />;
  }

  return (
    <div
      className="viewer"
      ref={containerRef}
      tabIndex={0}
      data-page={visiblePage}
      onScroll={(event) => {
        const container = event.currentTarget;
        const mid = container.scrollTop + container.clientHeight / 3;
        let closest = 0;
        let closestDistance = Number.POSITIVE_INFINITY;
        container.querySelectorAll<HTMLElement>('[data-page-index]').forEach((node) => {
          const distance = Math.abs(node.offsetTop - mid);
          if (distance < closestDistance) {
            closestDistance = distance;
            closest = Number(node.dataset.pageIndex);
          }
        });
        if (closest !== visiblePage) reportPage(closest);
      }}
    >
      {error ? (
        <div className="viewer-empty">
          <div className="modal" style={{ width: 460 }}>
            <header>
              <h2>The document could not be displayed</h2>
            </header>
            <div className="body">
              <p className="muted">{error}</p>
              <p className="hint">The file may be corrupted or protected with a password this build cannot read.</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="viewer-inner" style={{ opacity: bundle ? 1 : 0.6 }}>
          {pages.map((page, index) => (
            <PageItem
              key={`${index}-${page.rotation}`}
              index={index}
              page={page}
              scale={scale}
              bundle={bundle}
              annotations={(entry.annotations ?? []).filter((annotation) => annotation.pageIndex === index)}
              onVisible={reportPage}
              onRequestComposer={(rect, kind) => setComposer({ pageIndex: index, rect, kind })}
            />
          ))}
        </div>
      )}
      {composer ? (
        <TextComposer
          kind={composer.kind}
          onCancel={() => setComposer(null)}
          onSubmit={async (text) => {
            const input = annotationInputFromRect(composer.kind, composer.pageIndex, composer.rect, {
              text,
              color: useView.getState().color,
              fontSize: useView.getState().fontSize,
            });
            setComposer(null);
            await useApp.getState().apply([{ kind: 'addAnnotation', annotation: input }]);
          }}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One page                                                                    */
/* -------------------------------------------------------------------------- */

interface PageItemProps {
  index: number;
  page: PageInfo;
  scale: number;
  bundle: PdfBundle | null;
  annotations: Annotation[];
  onVisible(index: number): void;
  onRequestComposer(rect: Rect, kind: 'note' | 'freetext'): void;
}

interface Drawing {
  start: { x: number; y: number };
  current: { x: number; y: number };
  points: { x: number; y: number }[];
}

function PageItem({ index, page, scale, bundle, annotations, onVisible, onRequestComposer }: PageItemProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [spans, setSpans] = useState<TextSpan[]>([]);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [pdfPage, setPdfPage] = useState<PDFPageProxy | null>(null);
  const tool = useView((state) => state.tool);
  const showAnnotations = useView((state) => state.showAnnotations);
  const selected = useView((state) => state.selectedAnnotation);
  const color = useView((state) => state.color);
  const strokeWidth = useView((state) => state.strokeWidth);
  const opacity = useView((state) => state.opacity);
  const size = rotatedSize(page);
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            onVisible(index);
          }
        }
      },
      { root: element.closest('.viewer'), rootMargin: '600px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [index, onVisible]);

  useEffect(() => {
    if (!visible || !bundle || !canvasRef.current) return;
    let cancelled = false;
    const run = async (): Promise<void> => {
      const pageProxy = bundle.pages.get(index) ?? (await bundle.doc.getPage(index + 1));
      if (cancelled) return;
      bundle.pages.set(index, pageProxy);
      setPdfPage(pageProxy);
      if (canvasRef.current) await renderPage({ canvas: canvasRef.current, page: pageProxy, scale });
      if (cancelled) return;
      const built = await buildTextSpans(pageProxy, scale);
      if (!cancelled) setSpans(built.spans);
    };
    void run().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [visible, bundle, index, scale]);

  const viewport = pdfPage?.getViewport({ scale });

  const toRect = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }): Rect => {
      if (!viewport) {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      const [x1, y1] = viewport.convertToPdfPoint(Math.min(from.x, to.x), Math.min(from.y, to.y));
      const [x2, y2] = viewport.convertToPdfPoint(Math.max(from.x, to.x), Math.max(from.y, to.y));
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    },
    [viewport],
  );

  const toPoint = useCallback(
    (point: { x: number; y: number }) => {
      if (!viewport) return { x: 0, y: 0 };
      const [x, y] = viewport.convertToPdfPoint(point.x, point.y);
      return { x, y };
    },
    [viewport],
  );

  const cssRect = useCallback(
    (rect: Rect): { left: number; top: number; width: number; height: number } => {
      if (!viewport) return { left: 0, top: 0, width: 0, height: 0 };
      const [left, top] = viewport.convertToViewportPoint(rect.x, rect.y + rect.height);
      const [right, bottom] = viewport.convertToViewportPoint(rect.x + rect.width, rect.y);
      return {
        left: Math.min(left, right),
        top: Math.min(top, bottom),
        width: Math.abs(right - left),
        height: Math.abs(bottom - top),
      };
    },
    [viewport],
  );

  const pointer = (event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }): { x: number; y: number } => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const finishDrawing = async (state: Drawing): Promise<void> => {
    const { tool: activeTool } = useView.getState();
    const style = { color, opacity };
    const rect = toRect(state.start, state.current);
    let input: AnnotationInput | null = null;

    if (activeTool === 'ink') {
      const points = state.points.map(toPoint);
      if (points.length < 2) return;
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      input = {
        type: 'ink',
        pageIndex: index,
        rect: {
          x: Math.min(...xs) - strokeWidth,
          y: Math.min(...ys) - strokeWidth,
          width: Math.abs(Math.max(...xs) - Math.min(...xs)) + strokeWidth * 2,
          height: Math.abs(Math.max(...ys) - Math.min(...ys)) + strokeWidth * 2,
        },
        color,
        opacity,
        paths: [points],
        strokeWidth,
        editable: true,
      };
    } else if (activeTool === 'highlight' || activeTool === 'underline' || activeTool === 'strikeout') {
      if (rect.width < 2 || rect.height < 2) return;
      input = {
        type: activeTool,
        pageIndex: index,
        rect,
        quads: [rect],
        color,
        opacity: activeTool === 'highlight' ? Math.min(0.6, Math.max(0.2, opacity * 0.5)) : opacity,
        editable: true,
      };
    } else if (activeTool === 'square') {
      if (rect.width < 2 || rect.height < 2) return;
      input = {
        type: 'square',
        pageIndex: index,
        rect,
        color,
        opacity,
        strokeWidth,
        fill: null,
        start: toPoint(state.start),
        end: toPoint(state.current),
        editable: true,
      };
    } else if (activeTool === 'redact') {
      if (rect.width < 2 || rect.height < 2) return;
      input = {
        type: 'redact',
        pageIndex: index,
        rect,
        color: '#000000',
        opacity: 1,
        strokeWidth: 1,
        fill: '#000000',
        editable: true,
      };
    }

    setDrawing(null);
    if (!input) return;
    await useApp.getState().apply([{ kind: 'addAnnotation', annotation: input }]);
    void style;
  };

  const drawingTool = tool !== 'select' && tool !== 'note' && tool !== 'freetext';

  return (
    <div
      ref={wrapperRef}
      className="page"
      data-page-index={index}
      data-tool={tool}
      style={{ width, height }}
    >
      <canvas
        ref={canvasRef}
        className="page-canvas"
        style={{ width, height }}
        onPointerDown={(event) => {
          if (!drawingTool) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const point = pointer(event);
          setDrawing({ start: point, current: point, points: [point] });
        }}
        onPointerMove={(event) => {
          if (!drawing) return;
          const point = pointer(event);
          setDrawing((state) =>
            state
              ? {
                  ...state,
                  current: point,
                  points: state.points.length > 400 ? state.points : [...state.points, point],
                }
              : state,
          );
        }}
        onPointerUp={() => {
          if (drawing) void finishDrawing(drawing);
        }}
        onPointerCancel={() => setDrawing(null)}
        onClick={(event) => {
          if (tool === 'note' || tool === 'freetext') {
            const point = pointer(event);
            if (!viewport) return;
            const [x, y] = viewport.convertToPdfPoint(point.x, point.y);
            const box =
              tool === 'note'
                ? { x, y: y - 16, width: 16, height: 16 }
                : { x, y: y - 60, width: 220, height: 60 };
            onRequestComposer(box, tool);
          }
        }}
      />

      {spans.length > 0 && showAnnotations ? (
        <div className="text-layer" aria-hidden={false}>
          {spans.map((span, spanIndex) => (
            <span
              key={spanIndex}
              style={{
                left: `${span.left}px`,
                top: `${span.top}px`,
                fontSize: `${span.fontSize}px`,
                width: `${span.width}px`,
                transform: `scaleX(${span.width > 0 ? 1 : 1})`,
              }}
            >
              {span.text}
            </span>
          ))}
        </div>
      ) : null}

      {showAnnotations ? (
        <div className="annotation-layer" data-interactive={tool === 'select'}>
          {annotations.map((annotation) => {
            const box = cssRect(annotation.rect);
            const isSelected = selected === annotation.id;
            if (annotation.type === 'note') {
              return (
                <button
                  key={annotation.id}
                  type="button"
                  className="annotation-box note"
                  aria-selected={isSelected}
                  style={{ left: box.left, top: box.top, width: Math.max(16, box.width), height: Math.max(16, box.height) }}
                  title={annotation.contents ?? 'Note'}
                  onClick={() => useView.getState().selectAnnotation(isSelected ? null : annotation.id)}
                >
                  N
                </button>
              );
            }
            if (annotation.type === 'freetext') {
              return (
                <div
                  key={annotation.id}
                  className="annotation-box freetext"
                  aria-selected={isSelected}
                  style={{
                    left: box.left,
                    top: box.top,
                    width: box.width,
                    height: box.height,
                    color: annotation.color,
                    fontSize: `${annotation.fontSize * scale}px`,
                    background: annotation.background ?? 'transparent',
                    border: annotation.borderColor ? `${Math.max(1, annotation.borderWidth)}px solid ${annotation.borderColor}` : 'none',
                  }}
                  onClick={() => useView.getState().selectAnnotation(isSelected ? null : annotation.id)}
                >
                  {annotation.text}
                </div>
              );
            }
            if ((annotation.type === 'signature' || annotation.type === 'stamp') && 'image' in annotation && annotation.image) {
              return (
                <div
                  key={annotation.id}
                  className="annotation-box"
                  aria-selected={isSelected}
                  style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
                  onClick={() => useView.getState().selectAnnotation(isSelected ? null : annotation.id)}
                >
                  <img src={annotation.image} alt="signature" />
                </div>
              );
            }
            if (annotation.type === 'highlight' || annotation.type === 'underline' || annotation.type === 'strikeout' || annotation.type === 'squiggly') {
              return (
                <div key={annotation.id} aria-selected={isSelected}>
                  {annotation.quads.map((quad, quadIndex) => {
                    const quadBox = cssRect(quad);
                    const decoration =
                      annotation.type === 'highlight'
                        ? { background: withAlpha(annotation.color, Math.min(0.7, annotation.opacity ?? 0.35)) }
                        : annotation.type === 'underline'
                          ? { borderBottom: `2px solid ${annotation.color}`, background: 'transparent' }
                          : annotation.type === 'strikeout'
                            ? { background: `linear-gradient(transparent 45%, ${annotation.color} 45%, ${annotation.color} 58%, transparent 58%)` }
                            : { borderBottom: `1.5px wavy ${annotation.color}` };
                    return (
                      <div
                        key={quadIndex}
                        className="annotation-box"
                        aria-selected={isSelected}
                        style={{ left: quadBox.left, top: quadBox.top, width: quadBox.width, height: quadBox.height, ...decoration }}
                        onClick={() => useView.getState().selectAnnotation(isSelected ? null : annotation.id)}
                      />
                    );
                  })}
                </div>
              );
            }
            if (annotation.type === 'ink' || annotation.type === 'signature') {
              return (
                <svg
                  key={annotation.id}
                  className="ink-preview"
                  width={width}
                  height={height}
                  viewBox={`0 0 ${width} ${height}`}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                  onClick={() => useView.getState().selectAnnotation(isSelected ? null : annotation.id)}
                >
                  {annotation.paths.map((path, pathIndex) => (
                    <polyline
                      key={pathIndex}
                      points={path
                        .map((point) => {
                          if (!viewport) return '';
                          const [x, y] = viewport.convertToViewportPoint(point.x, point.y);
                          return `${x},${y}`;
                        })
                        .join(' ')}
                      fill="none"
                      stroke={annotation.color}
                      strokeWidth={Math.max(1, annotation.strokeWidth * scale)}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity={annotation.opacity}
                    />
                  ))}
                </svg>
              );
            }
            if (annotation.type === 'square' || annotation.type === 'circle' || annotation.type === 'redact') {
              return (
                <div
                  key={annotation.id}
                  className="annotation-box"
                  aria-selected={isSelected}
                  style={{
                    left: box.left,
                    top: box.top,
                    width: box.width,
                    height: box.height,
                    border: annotation.type === 'redact' ? 'none' : `${Math.max(1, (annotation.strokeWidth ?? 1) * scale)}px solid ${annotation.color}`,
                    background: annotation.type === 'redact' ? '#111111' : annotation.fill ? withAlpha(annotation.fill, 0.25) : 'transparent',
                    borderRadius: annotation.type === 'circle' ? '50%' : 0,
                  }}
                  onClick={() => useView.getState().selectAnnotation(isSelected ? null : annotation.id)}
                />
              );
            }
            if (annotation.type === 'link') {
              const link = annotation as Annotation & { url?: string };
              return (
                <div
                  key={annotation.id}
                  className="annotation-box"
                  aria-selected={isSelected}
                  style={{
                    left: box.left,
                    top: box.top,
                    width: box.width,
                    height: box.height,
                    border: '1px dashed var(--accent)',
                    background: 'var(--accent-soft)',
                    cursor: link.url ? 'pointer' : 'default',
                  }}
                  title={link.url ?? 'Link'}
                  onClick={() => {
                    if (link.url) void api.app.openExternal(link.url);
                    else useView.getState().selectAnnotation(isSelected ? null : annotation.id);
                  }}
                />
              );
            }
            return null;
          })}
        </div>
      ) : null}

      {drawing ? (
        tool === 'ink' ? (
          <svg className="ink-preview" width={width} height={height}>
            <polyline
              points={drawing.points.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={Math.max(1, strokeWidth)}
              strokeLinecap="round"
              opacity={opacity}
            />
          </svg>
        ) : (
          <div
            className="drag-rect"
            style={{
              left: Math.min(drawing.start.x, drawing.current.x),
              top: Math.min(drawing.start.y, drawing.current.y),
              width: Math.abs(drawing.current.x - drawing.start.x),
              height: Math.abs(drawing.current.y - drawing.start.y),
              borderColor: color,
              background: tool === 'redact' ? 'rgba(17,17,17,0.65)' : `${color}33`,
            }}
          />
        )
      ) : null}

      {!visible || !bundle ? <div className="page-placeholder" style={{ position: 'absolute', inset: 0 }} /> : null}
      <span className="page-number" style={{ bottom: -18 }}>
        {index + 1}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  if (value.length !== 6) return hex;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

function annotationInputFromRect(
  kind: 'note' | 'freetext',
  pageIndex: number,
  rect: Rect,
  options: { text: string; color: string; fontSize: number },
): AnnotationInput {
  if (kind === 'note') {
    return {
      type: 'note',
      pageIndex,
      rect,
      color: '#f5c542',
      opacity: 1,
      icon: 'Note',
      contents: options.text,
      open: true,
      editable: true,
    };
  }
  return {
    type: 'freetext',
    pageIndex,
    rect,
    color: '#111111',
    opacity: 1,
    text: options.text,
    fontSize: Math.max(4, options.fontSize),
    fontFamily: 'Inter',
    align: 'left',
    lineHeight: 1.25,
    bold: false,
    italic: false,
    background: null,
    borderColor: null,
    borderWidth: 0,
    editable: true,
  };
}

export { annotationInputFromRect, withAlpha };
export type { DocEntry };
