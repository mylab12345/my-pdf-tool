import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ListTree,
  MessageSquare,
  Paperclip,
  Plus,
  Search,
  Trash2,
  Image as ImageIcon,
} from 'lucide-react';
import type { Annotation } from '../../shared/types';
import { api, attempt, errorMessage } from '../lib/bridge';
import { useApp, useView, type SidebarTab } from '../store';

/**
 * Document sidebar.
 *
 * Thumbnails are rendered by the main process (one PNG per page, lazily as they
 * scroll into view) so the viewer's own pdf.js instance stays untouched. Outline,
 * annotations, search hits and attachments all navigate the same scroll
 * container through the `arena:go-to-page` event.
 */

const TABS: { id: SidebarTab; label: string; icon: React.ReactNode }[] = [
  { id: 'thumbnails', label: 'Pages', icon: <ImageIcon size={16} /> },
  { id: 'outline', label: 'Contents', icon: <ListTree size={16} /> },
  { id: 'annotations', label: 'Notes', icon: <MessageSquare size={16} /> },
  { id: 'search', label: 'Search', icon: <Search size={16} /> },
  { id: 'attachments', label: 'Files', icon: <Paperclip size={16} /> },
];

export function Sidebar(): ReactElement {
  const view = useView();
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] : undefined));
  if (!view.sidebarOpen || !entry) return <></>;

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="sidebar-tab"
            aria-selected={view.tab === tab.id}
            onClick={() => view.setTab(tab.id)}
            title={tab.label}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      <div className="sidebar-content">
        {view.tab === 'thumbnails' ? <Thumbnails /> : null}
        {view.tab === 'outline' ? <Outline /> : null}
        {view.tab === 'annotations' ? <AnnotationList /> : null}
        {view.tab === 'search' ? <SearchPanel /> : null}
        {view.tab === 'attachments' ? <AttachmentList /> : null}
      </div>
    </aside>
  );
}

function goToPage(pageIndex: number): void {
  window.dispatchEvent(new CustomEvent('arena:go-to-page', { detail: { pageIndex } }));
  useView.getState().setCurrentPage(pageIndex);
}

/* -------------------------------------------------------------------------- */
/* Thumbnails                                                                  */
/* -------------------------------------------------------------------------- */

function Thumbnails(): ReactElement {
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] : undefined));
  const currentPage = useView((state) => state.currentPage);
  const apply = useApp((state) => state.apply);
  const pages = entry?.info?.pages ?? [];

  if (!entry) return <div className="sidebar-empty">No document open.</div>;

  return (
    <div>
      {pages.map((page, index) => (
        <div key={index} className="thumbnail" role="button" tabIndex={0} aria-current={index === currentPage} onClick={() => goToPage(index)} onKeyDown={(event) => event.key === 'Enter' && goToPage(index)}>
          <div className="thumbnail-preview" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
            <ThumbnailImage id={entry.summary.id} pageIndex={index} revision={entry.revision} />
          </div>
          <div className="thumbnail-meta">
            <b>Page {index + 1}</b>
            <span>
              {Math.round(page.width)} × {Math.round(page.height)} pt
            </span>
            {page.rotation ? <span>rotated {page.rotation}°</span> : null}
            <div className="row" style={{ gap: 2, marginTop: 2 }}>
              <button
                type="button"
                className="icon-button"
                title="Move up"
                style={{ width: 22, height: 22 }}
                disabled={index === 0}
                onClick={(event) => {
                  event.stopPropagation();
                  void apply([{ kind: 'movePage', from: index, to: index - 1 }]);
                }}
              >
                <ArrowRight size={12} style={{ transform: 'rotate(-90deg)' }} />
              </button>
              <button
                type="button"
                className="icon-button"
                title="Move down"
                style={{ width: 22, height: 22 }}
                disabled={index === pages.length - 1}
                onClick={(event) => {
                  event.stopPropagation();
                  void apply([{ kind: 'movePage', from: index, to: index + 1 }]);
                }}
              >
                <ArrowRight size={12} style={{ transform: 'rotate(90deg)' }} />
              </button>
              <button
                type="button"
                className="icon-button danger"
                title="Delete page"
                style={{ width: 22, height: 22 }}
                disabled={pages.length <= 1}
                onClick={(event) => {
                  event.stopPropagation();
                  void apply([{ kind: 'deletePages', pages: [index] }]);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="button"
        style={{ width: '100%', justifyContent: 'center' }}
        onClick={() =>
          void apply([
            {
              kind: 'insertBlankPage',
              at: pages.length,
              size: 'Letter',
              orientation: pages.at(-1)?.width && pages.at(-1)!.width > pages.at(-1)!.height ? 'landscape' : 'portrait',
            },
          ])
        }
      >
        <Plus size={14} /> Add blank page
      </button>
    </div>
  );
}

function ThumbnailImage(props: { id: string; pageIndex: number; revision: number }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void attempt(api.documents.renderPage(props.id, props.pageIndex, 48)).then((rendered) => {
      if (cancelled || !rendered) return;
      const blob = new Blob([new Uint8Array(rendered.data)], { type: 'image/png' });
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, props.id, props.pageIndex, props.revision]);

  return (
    <div ref={ref} style={{ width: '100%', height: '100%', background: '#fff' }}>
      {url ? <img src={url} alt={`Page ${props.pageIndex + 1}`} style={{ width: '100%', display: 'block' }} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Outline                                                                     */
/* -------------------------------------------------------------------------- */

function Outline(): ReactElement {
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] : undefined));
  const setModal = useApp((state) => state.setModal);
  const outline = entry?.info?.outline ?? [];

  if (!outline.length) {
    return (
      <div className="sidebar-empty">
        This document has no table of contents.
        <div style={{ marginTop: 10 }}>
          <button type="button" className="button" onClick={() => setModal('metadata')}>
            Add bookmarks
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {outline.map((item, index) => (
        <div key={`${item.title}-${index}`}>
          <button type="button" className="outline-item" onClick={() => item.pageIndex !== null && goToPage(item.pageIndex)}>
            <span style={{ flex: 1 }}>{item.title}</span>
            {item.pageIndex !== null ? <span className="muted small">{item.pageIndex + 1}</span> : null}
          </button>
          {item.children?.map((child, childIndex) => (
            <button
              key={`${child.title}-${childIndex}`}
              type="button"
              className="outline-item"
              style={{ paddingLeft: 20, fontSize: 11.5, color: 'var(--text-muted)' }}
              onClick={() => child.pageIndex !== null && goToPage(child.pageIndex)}
            >
              {child.title}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Annotations                                                                 */
/* -------------------------------------------------------------------------- */

function describe(annotation: Annotation): string {
  switch (annotation.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'squiggly':
      return 'Text markup';
    case 'note':
      return annotation.contents?.slice(0, 80) || 'Note';
    case 'freetext':
      return annotation.text.slice(0, 80);
    case 'ink':
      return 'Freehand drawing';
    case 'signature':
      return 'Signature';
    case 'stamp':
      return annotation.label ?? 'Stamp';
    case 'square':
      return 'Rectangle';
    case 'circle':
      return 'Ellipse';
    case 'redact':
      return 'Redaction mark';
    case 'link':
      return annotation.url ?? 'Link';
    default:
      return annotation.type;
  }
}

function AnnotationList(): ReactElement {
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] : undefined));
  const apply = useApp((state) => state.apply);
  const selected = useView((state) => state.selectedAnnotation);
  const annotations = entry?.annotations ?? [];

  if (!annotations.length) {
    return <div className="sidebar-empty">No annotations yet. Pick a tool above the page and mark it up.</div>;
  }

  return (
    <div>
      {annotations.map((annotation) => (
        <div
          key={annotation.id}
          className="list-row"
          style={{ cursor: 'pointer', borderColor: selected === annotation.id ? 'var(--accent)' : undefined }}
          onClick={() => {
            goToPage(annotation.pageIndex);
            useView.getState().selectAnnotation(annotation.id);
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              marginTop: 4,
              background: annotation.type === 'highlight' ? '#f5c542' : annotation.color,
              flexShrink: 0,
            }}
          />
          <div className="row-main">
            <div className="row-title">{describe(annotation)}</div>
            <div className="row-sub">
              Page {annotation.pageIndex + 1}
              {annotation.author ? ` · ${annotation.author}` : ''}
            </div>
          </div>
          <button
            type="button"
            className="icon-button danger"
            title="Delete annotation"
            style={{ width: 24, height: 24 }}
            onClick={(event) => {
              event.stopPropagation();
              void apply([{ kind: 'removeAnnotation', id: annotation.id }]);
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

interface SearchHit {
  pageIndex: number;
  snippet: string;
}

function SearchPanel(): ReactElement {
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] : undefined));
  const query = useView((state) => state.search);
  const setSearch = useView((state) => state.setSearch);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullText, setFullText] = useState<{ pageIndex: number; text: string }[] | null>(null);

  const id = entry?.summary.id;
  const revision = entry?.revision;

  const loadText = useCallback(async () => {
    if (!id) return;
    if (fullText) return;
    setBusy(true);
    try {
      const result = await attempt(api.tools.extractText(id));
      if (result) setFullText(result.pages);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [id, fullText]);

  useEffect(() => {
    setFullText(null);
    setHits([]);
  }, [id, revision]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      void loadText().then(() => {
        const needle = query.toLowerCase();
        const pages = fullText ?? [];
        const found: SearchHit[] = [];
        for (const page of pages) {
          const haystack = page.text.toLowerCase();
          let index = haystack.indexOf(needle);
          let count = 0;
          while (index !== -1 && count < 25) {
            found.push({
              pageIndex: page.pageIndex,
              snippet: page.text.slice(Math.max(0, index - 40), Math.min(page.text.length, index + needle.length + 60)).replace(/\s+/g, ' '),
            });
            index = haystack.indexOf(needle, index + needle.length);
            count += 1;
          }
        }
        setHits(found);
      });
    }, 260);
    return () => clearTimeout(timer);
  }, [query, loadText, fullText]);

  return (
    <div>
      <div className="search-field">
        <Search size={14} className="muted" />
        <input
          autoFocus
          type="search"
          placeholder="Find in document…"
          value={query}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {busy ? <div className="sidebar-empty">Extracting text…</div> : null}
      {error ? <div className="sidebar-empty">{error}</div> : null}
      {!busy && query && hits.length === 0 ? (
        <div className="sidebar-empty">
          {fullText && fullText.every((page) => !page.text.trim())
            ? 'This document has no text layer. Run OCR to make it searchable.'
            : 'No matches.'}
        </div>
      ) : null}
      {hits.map((hit, index) => (
        <div key={`${hit.pageIndex}-${index}`} className="list-row" style={{ cursor: 'pointer' }} onClick={() => goToPage(hit.pageIndex)}>
          <div className="row-main">
            <div className="row-title">Page {hit.pageIndex + 1}</div>
            <div className="row-sub">{hit.snippet}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Attachments                                                                 */
/* -------------------------------------------------------------------------- */

function AttachmentList(): ReactElement {
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] : undefined));
  const refresh = useApp((state) => state.refresh);
  const toast = useApp((state) => state.toast);
  const [items, setItems] = useState<{ name: string; size: number; description?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = entry?.summary.id;
  const revision = entry?.revision;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void attempt(api.tools.attachmentsList(id)).then((list) => {
      if (!cancelled) setItems(list ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [id, revision]);

  if (!entry) return <div className="sidebar-empty">No document open.</div>;

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={async (event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          for (const file of files) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const result = await api.tools.attachmentsAdd(entry.summary.id, { name: file.name, data: bytes });
            if (!result.ok) toast('error', 'Attachment could not be added', result.error.message);
          }
          await refresh(entry.summary.id);
        }}
      />
      <button type="button" className="button" style={{ width: '100%', justifyContent: 'center', marginBottom: 10 }} onClick={() => inputRef.current?.click()} disabled={busy}>
        <Plus size={14} /> Attach a file
      </button>
      {items.length === 0 ? <div className="sidebar-empty">No embedded files. Attachments travel with the PDF.</div> : null}
      {items.map((item) => (
        <div key={item.name} className="list-row">
          <Paperclip size={14} className="muted" style={{ marginTop: 2 }} />
          <div className="row-main">
            <div className="row-title">{item.name}</div>
            <div className="row-sub">{(item.size / 1024).toFixed(1)} KB{item.description ? ` · ${item.description}` : ''}</div>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Save attachment"
            style={{ width: 24, height: 24 }}
            onClick={async () => {
              setBusy(true);
              const result = await api.tools.attachmentsExtract(entry.summary.id, item.name);
              setBusy(false);
              if (result.ok) toast('success', 'Attachment saved');
              else if (result.error.code !== 'CANCELLED') toast('error', 'Could not save the attachment', result.error.message);
            }}
          >
            <ArrowRight size={13} style={{ transform: 'rotate(90deg)' }} />
          </button>
          <button
            type="button"
            className="icon-button danger"
            title="Remove attachment"
            style={{ width: 24, height: 24 }}
            onClick={async () => {
              const result = await api.tools.attachmentsRemove(entry.summary.id, item.name);
              if (result.ok) await refresh(entry.summary.id);
              else toast('error', 'Could not remove the attachment', result.error.message);
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
