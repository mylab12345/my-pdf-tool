import type { ReactElement } from 'react';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';

/**
 * Base modal: focus safe, Escape closes, scroll locked behind the backdrop.
 * Tool dialogs are plain forms inside this shell so they all behave the same.
 */
export function Modal(props: {
  title: string;
  subtitle?: string;
  wide?: boolean;
  onClose(): void;
  footer?: ReactNode;
  children: ReactNode;
}): ReactElement {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [props]);

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose} role="presentation">
      <div className={`modal${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>{props.title}</h2>
            {props.subtitle ? <p>{props.subtitle}</p> : null}
          </div>
          <button type="button" className="icon-button" onClick={props.onClose} title="Close">
            <X size={16} />
          </button>
        </header>
        <div className="body">{props.children}</div>
        {props.footer ? <footer>{props.footer}</footer> : null}
      </div>
    </div>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <div className="field">
      <label>{props.label}</label>
      {props.children}
      {props.hint ? <small>{props.hint}</small> : null}
    </div>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
}): ReactElement {
  return (
    <div className="segmented">
      {props.options.map((option) => (
        <button key={option.value} type="button" aria-pressed={props.value === option.value} onClick={() => props.onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox(props: { checked: boolean; onChange(checked: boolean): void; label: string; hint?: string }): ReactElement {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>
        {props.label}
        {props.hint ? <span className="muted small"> — {props.hint}</span> : null}
      </span>
    </label>
  );
}
