import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Cpu, Download, FolderOpen } from 'lucide-react';
import type { PageSizeName } from '../../shared/types';
import { api, attempt } from '../lib/bridge';
import { useApp, useView, type ModalName } from '../store';
import { Checkbox, Field, Modal, Segmented } from './Modal';
import {
  CompressModal,
  ConvertModal,
  EncryptModal,
  FormsModal,
  HeaderFooterModal,
  MergeModal,
  MetadataModal,
  NewDocumentModal,
  OcrModal,
  PrintModal,
  RecoveryModal,
  RedactModal,
  SignModal,
  SplitModal,
  WatermarkModal,
} from './ToolModals';

/** Single mount point for every dialog; the store decides which one is open. */
export function Modals(): ReactElement | null {
  const modal = useApp((state) => state.modal);
  if (!modal) return null;
  switch (modal) {
    case 'ocr':
      return <OcrModal />;
    case 'compress':
      return <CompressModal />;
    case 'encrypt':
      return <EncryptModal />;
    case 'sign':
      return <SignModal />;
    case 'redact':
      return <RedactModal />;
    case 'watermark':
      return <WatermarkModal />;
    case 'headerFooter':
      return <HeaderFooterModal />;
    case 'convert':
      return <ConvertModal />;
    case 'split':
      return <SplitModal />;
    case 'merge':
      return <MergeModal />;
    case 'forms':
      return <FormsModal />;
    case 'metadata':
      return <MetadataModal />;
    case 'print':
      return <PrintModal />;
    case 'newDocument':
      return <NewDocumentModal />;
    case 'recovery':
      return <RecoveryModal />;
    case 'settings':
      return <SettingsModal />;
    case 'shortcuts':
      return <ShortcutsModal />;
    case 'about':
      return <AboutModal />;
    case 'attachments':
      return <SidebarRedirect tab="attachments" />;
    case 'outline':
      return <SidebarRedirect tab="outline" />;
    default:
      return null;
  }
}

/** Some "dialogs" are really sidebar panels; route them there. */
function SidebarRedirect(props: { tab: 'attachments' | 'outline' }): ReactElement | null {
  const setModal = useApp((state) => state.setModal);
  useEffect(() => {
    useView.getState().setTab(props.tab);
    setModal(null);
  }, [props.tab, setModal]);
  return null;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export function SettingsModal(): ReactElement | null {
  const setModal = useApp((state) => state.setModal);
  const settings = useApp((state) => state.settings);
  const updateSettings = useApp((state) => state.updateSettings);
  const environment = useApp((state) => state.environment);
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  if (!draft) return null;

  const patch = (next: Partial<typeof draft>): void => setDraft({ ...draft, ...next });

  return (
    <Modal
      title="Settings"
      subtitle="Stored locally in your user profile."
      wide
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            onClick={async () => {
              await updateSettings(draft);
              setModal(null);
            }}
          >
            Save settings
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Theme">
          <Segmented<'system' | 'light' | 'dark'>
            value={draft.theme}
            onChange={(theme) => patch({ theme })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Field>
        <Field label="Accent colour">
          <input type="color" value={draft.accent} onChange={(event) => patch({ accent: event.target.value })} />
        </Field>
      </div>

      <div className="field-row">
        <Field label="Default page size">
          <select value={draft.defaultPageSize} onChange={(event) => patch({ defaultPageSize: event.target.value as PageSizeName })}>
            {(['A4', 'Letter', 'Legal', 'A3', 'A5'] as PageSizeName[]).map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Default orientation">
          <Segmented<'portrait' | 'landscape'>
            value={draft.defaultOrientation}
            onChange={(orientation) => patch({ defaultOrientation: orientation })}
            options={[
              { value: 'portrait', label: 'Portrait' },
              { value: 'landscape', label: 'Landscape' },
            ]}
          />
        </Field>
      </div>

      <div className="field-row">
        <Field label="Compression profile">
          <select
            value={draft.defaultCompressionProfile}
            onChange={(event) => patch({ defaultCompressionProfile: event.target.value as typeof draft.defaultCompressionProfile })}
          >
            <option value="lossless">Lossless</option>
            <option value="balanced">Balanced</option>
            <option value="aggressive">Aggressive</option>
            <option value="custom">Custom</option>
          </select>
        </Field>
        <Field label="Default OCR languages" hint="Comma separated tesseract codes">
          <input
            type="text"
            value={draft.defaultOcrLanguages.join(', ')}
            onChange={(event) =>
              patch({
                defaultOcrLanguages: event.target.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
        <Field label="Render DPI" hint="Used for thumbnails and previews">
          <input
            type="number"
            min={72}
            max={300}
            value={draft.renderDpi}
            onChange={(event) => patch({ renderDpi: Number(event.target.value) })}
          />
        </Field>
      </div>

      <div className="stack">
        <Checkbox
          checked={draft.autosaveEnabled}
          onChange={(autosaveEnabled) => patch({ autosaveEnabled })}
          label="Autosave recovery snapshots"
          hint="lets you recover unsaved work after a crash"
        />
        <Field label={`Snapshot interval — ${draft.autosaveIntervalSeconds}s`}>
          <input
            type="range"
            min={15}
            max={600}
            step={15}
            value={draft.autosaveIntervalSeconds}
            onChange={(event) => patch({ autosaveIntervalSeconds: Number(event.target.value) })}
            disabled={!draft.autosaveEnabled}
          />
        </Field>
        <Checkbox checked={draft.confirmOnClose} onChange={(confirmOnClose) => patch({ confirmOnClose })} label="Ask before closing with unsaved changes" />
        <Checkbox checked={draft.showSidebar} onChange={(showSidebar) => patch({ showSidebar })} label="Show the sidebar by default" />
      </div>

      {environment ? (
        <div className="hint">
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <Cpu size={14} />
            <strong>Environment</strong>
          </div>
          <div className="small">
            {environment.appVersion} · Electron {environment.electronVersion} · Chromium {environment.chromeVersion}
            <br />
            {environment.osVersion} · {environment.arch} · {environment.cpuCount} CPUs · {environment.totalMemoryMb} MB RAM
            <br />
            OCR data: {environment.ocrLanguages.join(', ') || 'none installed'}
          </div>
          <div className="row" style={{ marginTop: 8, gap: 8 }}>
            <button type="button" className="button" onClick={() => void api.app.revealPath(environment.paths.userData)}>
              <FolderOpen size={14} /> Open data folder
            </button>
            <button
              type="button"
              className="button"
              onClick={async () => {
                const report = await attempt(api.app.report());
                if (report) await api.clipboard.writeText(report);
              }}
            >
              <Download size={14} /> Copy diagnostics
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Keyboard shortcuts                                                          */
/* -------------------------------------------------------------------------- */

const SHORTCUTS: [string, string][] = [
  ['Ctrl + O', 'Open documents'],
  ['Ctrl + N', 'New PDF'],
  ['Ctrl + S', 'Save'],
  ['Ctrl + Shift + S', 'Save as'],
  ['Ctrl + P', 'Print'],
  ['Ctrl + W', 'Close document'],
  ['Ctrl + Z', 'Undo'],
  ['Ctrl + Shift + Z', 'Redo'],
  ['Ctrl + F', 'Find in document'],
  ['Ctrl + =  /  Ctrl + -', 'Zoom in / out'],
  ['Ctrl + 1 / Ctrl + 0', 'Fit width / fit page'],
  ['Ctrl + B', 'Toggle sidebar'],
  ['Page Down / Page Up', 'Next / previous page'],
  ['Delete', 'Delete selected annotation'],
  ['V / H / D / R / N / T / X', 'Select, highlight, draw, rectangle, note, text, redact'],
  ['Escape', 'Leave the current tool'],
];

export function ShortcutsModal(): ReactElement {
  const setModal = useApp((state) => state.setModal);
  return (
    <Modal
      title="Keyboard shortcuts"
      onClose={() => setModal(null)}
      footer={
        <button type="button" className="button primary" onClick={() => setModal(null)}>
          Close
        </button>
      }
    >
      <div className="shortcut-grid">
        {SHORTCUTS.map(([keys, action]) => (
          <div key={keys} style={{ display: 'contents' }}>
            <span>{action}</span>
            <span className="kbd">{keys}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* About                                                                       */
/* -------------------------------------------------------------------------- */

export function AboutModal(): ReactElement {
  const setModal = useApp((state) => state.setModal);
  const environment = useApp((state) => state.environment);
  const [report, setReport] = useState('');

  useEffect(() => {
    void attempt(api.app.report()).then((value) => setReport(value ?? ''));
  }, []);

  return (
    <Modal
      title="About Arena PDF Studio"
      subtitle="A local-first PDF workspace for Windows and Linux."
      onClose={() => setModal(null)}
      footer={
        <button type="button" className="button primary" onClick={() => setModal(null)}>
          Close
        </button>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.6 }}>
        Arena PDF Studio edits, converts, signs and protects PDF files without sending a single byte over the network. It is built
        on open-source components: pdf-lib (MIT), pdf.js (Apache-2.0), tesseract.js (Apache-2.0), @napi-rs/canvas (MIT),
        @signpdf (MIT), node-forge (BSD-3-Clause), React (MIT) and Electron (MIT).
      </p>
      <div className="hint mono" style={{ whiteSpace: 'pre-wrap' }}>
        {report || (environment ? `${environment.appVersion} · ${environment.platform} · Electron ${environment.electronVersion}` : '')}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Printing, OCR, encryption and signatures all run in-process. No telemetry is collected and no account is required.
      </p>
    </Modal>
  );
}

export type { ModalName };
