import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

/**
 * Inline text entry for notes and free text annotations.
 *
 * Electron has no `window.prompt`, so every textual annotation uses this small
 * composer anchored to the middle of the page area. Escape cancels, Ctrl+Enter
 * commits.
 */
export function TextComposer(props: {
  kind: 'note' | 'freetext';
  onSubmit(text: string): void;
  onCancel(): void;
}): ReactElement {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="modal-backdrop" style={{ background: 'transparent', backdropFilter: 'none' }} onMouseDown={props.onCancel}>
      <div
        className="modal"
        style={{ width: 420, position: 'fixed', left: '50%', top: '22%', transform: 'translateX(-50%)' }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2>{props.kind === 'note' ? 'Add note' : 'Add text box'}</h2>
            <p>Ctrl+Enter to place the annotation, Escape to cancel.</p>
          </div>
        </header>
        <div className="body">
          <textarea
            ref={ref}
            value={text}
            placeholder={props.kind === 'note' ? 'Note text…' : 'Text to place on the page…'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') props.onCancel();
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                if (text.trim()) props.onSubmit(text.trim());
              }
            }}
          />
        </div>
        <footer>
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!text.trim()}
            onClick={() => props.onSubmit(text.trim())}
          >
            Place annotation
          </button>
        </footer>
      </div>
    </div>
  );
}
