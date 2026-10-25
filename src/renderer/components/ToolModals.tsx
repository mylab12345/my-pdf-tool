import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BadgeCheck, Download, FileDown, Loader2, ShieldCheck } from 'lucide-react';
import type {
  Annotation,
  CompressionOptions,
  PageSizeName,
  Rect,
  SecurityOptions,
  SignatureVerification,
  TextExportFormat,
} from '../../shared/types';
import { api, attempt, errorMessage, run } from '../lib/bridge';
import { useApp, useView } from '../store';
import { Checkbox, Field, Modal, Segmented } from './Modal';

/**
 * Tool dialogs.
 *
 * Each dialog is a thin form: it collects options, calls one main-process tool
 * and reports the result. Long-running work (OCR, compression, redaction)
 * reports progress through the task strip; failures surface as toasts instead of
 * silent console noise.
 */

function useActive() {
  const id = useApp((state) => state.activeId);
  const entry = useApp((state) => (state.activeId ? state.docs[state.activeId] : undefined));
  return { id, entry };
}

function useTaskRunner(): { busy: boolean; runTask<T>(fn: (taskId: string) => Promise<T>): Promise<T | null> } {
  const [busy, setBusy] = useState(false);
  const runTask = useCallback(async <T,>(fn: (taskId: string) => Promise<T>): Promise<T | null> => {
    setBusy(true);
    const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      return await fn(taskId);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, runTask };
}

function BusyLabel(props: { busy: boolean }): ReactElement | null {
  if (!props.busy) return null;
  return (
    <p className="hint row" style={{ gap: 8 }}>
      <Loader2 size={14} className="spin" /> Working — progress is shown in the task strip at the bottom right.
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* OCR                                                                         */
/* -------------------------------------------------------------------------- */

export function OcrModal(): ReactElement {
  const { id, entry } = useActive();
  const { busy, runTask } = useTaskRunner();
  const setModal = useApp((state) => state.setModal);
  const refresh = useApp((state) => state.refresh);
  const toast = useApp((state) => state.toast);
  const settings = useApp((state) => state.settings);
  const [languages, setLanguages] = useState<string[]>(settings?.defaultOcrLanguages ?? ['eng']);
  const [available, setAvailable] = useState<{ code: string; name: string; installed: boolean }[]>([]);
  const [dpi, setDpi] = useState(300);
  const [searchable, setSearchable] = useState(true);
  const [pages, setPages] = useState('');
  const [result, setResult] = useState<{ text: string; confidence: number; pages: number } | null>(null);

  useEffect(() => {
    void attempt(api.tools.ocrLanguages()).then((list) => setAvailable(list ?? []));
  }, []);

  const installed = available.filter((language) => language.installed);

  const start = async (): Promise<void> => {
    if (!id) return;
    const parsedPages = pages.trim() ? pages.split(',').map((value) => Number.parseInt(value.trim(), 10) - 1).filter((value) => Number.isFinite(value) && value >= 0) : null;
    try {
      const outcome = await runTask((taskId) =>
        run(
          api.tools.ocr(
            id,
            {
              languages,
              dpi,
              pages: parsedPages,
              searchablePdf: searchable,
            },
            taskId,
          ),
        ),
      );
      if (!outcome) return;
      setResult({ text: outcome.text, confidence: outcome.confidence, pages: outcome.pages.length });
      await refresh(id);
      toast('success', 'OCR finished', `${Math.round(outcome.confidence)}% mean confidence across ${outcome.pages.length} page(s)`);
    } catch (error) {
      toast('error', 'OCR failed', errorMessage(error));
    }
  };

  return (
    <Modal
      title="Recognise text (OCR)"
      subtitle="Runs entirely offline with the bundled tesseract engine."
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Close
          </button>
          <button type="button" className="button primary" onClick={() => void start()} disabled={!id || busy || languages.length === 0}>
            {busy ? 'Recognising…' : 'Start OCR'}
          </button>
        </>
      }
    >
      <Field label="Languages" hint="Pick the scripts present in the document. Multiple languages are recognised together.">
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {installed.length === 0 ? <span className="muted small">No language data installed.</span> : null}
          {installed.map((language) => (
            <label key={language.code} className="checkbox">
              <input
                type="checkbox"
                checked={languages.includes(language.code)}
                onChange={(event) =>
                  setLanguages((current) =>
                    event.target.checked ? [...current, language.code] : current.filter((code) => code !== language.code),
                  )
                }
              />
              {language.name}
            </label>
          ))}
        </div>
      </Field>
      <div className="field-row">
        <Field label="Resolution (DPI)" hint="300 DPI is a good balance for scans.">
          <input type="number" min={72} max={600} value={dpi} onChange={(event) => setDpi(Number(event.target.value))} />
        </Field>
        <Field label="Pages" hint="Empty = all pages. Example: 1,3-5">
          <input type="text" placeholder="All pages" value={pages} onChange={(event) => setPages(event.target.value)} />
        </Field>
      </div>
      <Checkbox
        checked={searchable}
        onChange={setSearchable}
        label="Add an invisible text layer"
        hint="makes the document searchable and selectable"
      />
      <BusyLabel busy={busy} />
      {entry?.info && entry.info.textCharacters === 0 ? (
        <p className="hint row" style={{ gap: 8 }}>
          <AlertTriangle size={14} /> This document has no text layer — it looks like a scan, so OCR is the right tool.
        </p>
      ) : null}
      {result ? (
        <div className="stack">
          <div className="row between">
            <strong>Recognised text</strong>
            <span className="badge-pill good">
              <BadgeCheck size={12} /> {Math.round(result.confidence)}% confidence
            </span>
          </div>
          <textarea readOnly value={result.text} style={{ minHeight: 160 }} />
          <div className="row">
            <button type="button" className="button" onClick={() => void navigator.clipboard.writeText(result.text)}>
              Copy text
            </button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Compression                                                                 */
/* -------------------------------------------------------------------------- */

export function CompressModal(): ReactElement {
  const { id, entry } = useActive();
  const { busy, runTask } = useTaskRunner();
  const setModal = useApp((state) => state.setModal);
  const refresh = useApp((state) => state.refresh);
  const toast = useApp((state) => state.toast);
  const settings = useApp((state) => state.settings);
  const [profile, setProfile] = useState<CompressionOptions['profile']>(settings?.defaultCompressionProfile ?? 'balanced');
  const [rasterize, setRasterize] = useState(false);
  const [strip, setStrip] = useState(true);
  const [grayscale, setGrayscale] = useState(false);
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(72);
  const [result, setResult] = useState<{ before: number; after: number; method: string } | null>(null);

  const start = async (): Promise<void> => {
    if (!id) return;
    try {
      const outcome = await runTask((taskId) =>
        run(
          api.tools.compress(
            id,
            {
              profile,
              dpi,
              quality,
              rasterizePages: rasterize,
              stripMetadata: strip,
              imageDpi: dpi,
              grayscale,
            },
            taskId,
          ),
        ),
      );
      if (!outcome) return;
      setResult({ before: outcome.result.originalSize, after: outcome.result.compressedSize, method: outcome.result.method });
      await refresh(id);
      toast('success', 'Document compressed', `${formatBytes(outcome.result.originalSize)} → ${formatBytes(outcome.result.compressedSize)}`);
    } catch (error) {
      toast('error', 'Compression failed', errorMessage(error));
    }
  };

  return (
    <Modal
      title="Compress document"
      subtitle={entry ? `${entry.summary.name} · ${formatBytes(entry.summary.fileSize)}` : undefined}
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Close
          </button>
          <button type="button" className="button primary" onClick={() => void start()} disabled={!id || busy}>
            {busy ? 'Compressing…' : 'Compress'}
          </button>
        </>
      }
    >
      <Field label="Profile">
        <Segmented<CompressionOptions['profile']>
          value={profile}
          onChange={(next) => {
            setProfile(next);
            if (next === 'lossless') {
              setRasterize(false);
              setDpi(150);
              setQuality(85);
            } else if (next === 'balanced') {
              setRasterize(false);
              setDpi(150);
              setQuality(72);
            } else if (next === 'aggressive') {
              setRasterize(true);
              setDpi(110);
              setQuality(55);
            }
          }}
          options={[
            { value: 'lossless', label: 'Lossless' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'aggressive', label: 'Aggressive' },
            { value: 'custom', label: 'Custom' },
          ]}
        />
      </Field>
      <div className="field-row">
        <Field label="Image DPI">
          <input type="number" min={36} max={600} value={dpi} onChange={(event) => setDpi(Number(event.target.value))} />
        </Field>
        <Field label="JPEG quality">
          <input type="number" min={1} max={100} value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
        </Field>
      </div>
      <Checkbox checked={strip} onChange={setStrip} label="Strip metadata" hint="removes author, producer and thumbnails" />
      <Checkbox checked={grayscale} onChange={setGrayscale} label="Convert images to grayscale" />
      <Checkbox
        checked={rasterize}
        onChange={setRasterize}
        label="Rasterise pages"
        hint="smallest files, but the text layer and form fields are lost"
      />
      {rasterize ? (
        <p className="hint row" style={{ gap: 8 }}>
          <AlertTriangle size={14} /> Rasterising flattens the document. Keep an uncompressed copy if you need to edit later.
        </p>
      ) : null}
      <BusyLabel busy={busy} />
      {result ? (
        <div className="hint">
          {formatBytes(result.before)} → <strong>{formatBytes(result.after)}</strong> ({Math.max(0, Math.round((1 - result.after / result.before) * 100))}%
          smaller, {result.method})
        </div>
      ) : null}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Security                                                                    */
/* -------------------------------------------------------------------------- */

export function EncryptModal(): ReactElement {
  const { id, entry } = useActive();
  const setModal = useApp((state) => state.setModal);
  const refresh = useApp((state) => state.refresh);
  const toast = useApp((state) => state.toast);
  const [userPassword, setUserPassword] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [algorithm, setAlgorithm] = useState<NonNullable<SecurityOptions['algorithm']>>('AES-256');
  const [permissions, setPermissions] = useState({
    printing: true,
    copying: true,
    annotating: true,
    fillingForms: true,
    modifying: false,
    contentAccessibility: true,
    documentAssembly: false,
  });
  const [busy, setBusy] = useState(false);
  const [ownerUnlock, setOwnerUnlock] = useState('');

  const encrypt = async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await run(api.tools.encrypt(id, { userPassword, ownerPassword: ownerPassword || userPassword, algorithm, permissions }));
      await refresh(id);
      toast('success', 'Document encrypted', 'A password is required to open this file.');
      setModal(null);
    } catch (error) {
      toast('error', 'Encryption failed', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const decrypt = async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await run(api.tools.decrypt(id, ownerUnlock));
      await refresh(id);
      toast('success', 'Protection removed');
      setModal(null);
    } catch (error) {
      toast('error', 'Could not remove protection', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Encrypt &amp; permissions"
      subtitle={entry?.summary.encrypted ? 'This document is currently protected.' : 'AES-256 encryption, processed locally.'}
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => void encrypt()} disabled={!id || busy || !userPassword}>
            Apply encryption
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Open password" hint="Required to open the document.">
          <input type="password" value={userPassword} onChange={(event) => setUserPassword(event.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Owner password" hint="Controls permissions. Defaults to the open password.">
          <input type="password" value={ownerPassword} onChange={(event) => setOwnerPassword(event.target.value)} autoComplete="new-password" />
        </Field>
      </div>
      <Field label="Algorithm">
        <Segmented
          value={algorithm}
          onChange={(next) => setAlgorithm(next)}
          options={[
            { value: 'AES-256', label: 'AES-256' },
            { value: 'AES-128', label: 'AES-128' },
            { value: 'RC4-128', label: 'RC4 (legacy)' },
          ]}
        />
      </Field>
      <div className="stack">
        <span className="field-label">Allow</span>
        <Checkbox checked={permissions.printing} onChange={(value) => setPermissions({ ...permissions, printing: value })} label="Printing" />
        <Checkbox checked={permissions.copying} onChange={(value) => setPermissions({ ...permissions, copying: value })} label="Copying text" />
        <Checkbox checked={permissions.annotating} onChange={(value) => setPermissions({ ...permissions, annotating: value })} label="Annotating" />
        <Checkbox checked={permissions.fillingForms} onChange={(value) => setPermissions({ ...permissions, fillingForms: value })} label="Filling forms" />
        <Checkbox checked={permissions.modifying} onChange={(value) => setPermissions({ ...permissions, modifying: value })} label="Editing content" />
        <Checkbox
          checked={permissions.contentAccessibility}
          onChange={(value) => setPermissions({ ...permissions, contentAccessibility: value })}
          label="Screen-reader access"
        />
        <Checkbox checked={permissions.documentAssembly} onChange={(value) => setPermissions({ ...permissions, documentAssembly: value })} label="Assembling pages" />
      </div>
      {entry?.summary.encrypted ? (
        <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <Field label="Remove protection" hint="Enter the owner (permissions) password to save an unprotected copy.">
            <input type="password" value={ownerUnlock} onChange={(event) => setOwnerUnlock(event.target.value)} />
          </Field>
          <button type="button" className="button" onClick={() => void decrypt()} disabled={busy}>
            Remove password
          </button>
        </div>
      ) : null}
      <BusyLabel busy={busy} />
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Signatures                                                                  */
/* -------------------------------------------------------------------------- */

export function SignModal(): ReactElement {
  const { id, entry } = useActive();
  const setModal = useApp((state) => state.setModal);
  const refresh = useApp((state) => state.refresh);
  const toast = useApp((state) => state.toast);
  const [mode, setMode] = useState<'draw' | 'certificate'>('draw');
  const [image, setImage] = useState<string | null>(null);
  const [p12, setP12] = useState<string | null>(null);
  const [p12Name, setP12Name] = useState('');
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('Approved');
  const [location, setLocation] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [verification, setVerification] = useState<SignatureVerification | null>(null);
  const page = entry?.info?.pages[pageIndex];

  const rect: Rect | null = page ? { x: page.width - 220, y: 40, width: 180, height: 60 } : null;

  const sign = async (): Promise<void> => {
    if (!id || !rect) return;
    setBusy(true);
    try {
      const outcome = await run(
        api.tools.sign(id, {
          ...(image ? { image } : {}),
          ...(mode === 'certificate' && p12 ? { p12, p12Password: password } : {}),
          digital: mode === 'certificate',
          reason,
          ...(location ? { location } : {}),
          pageIndex,
          rect,
        }),
      );
      setVerification(outcome.verification);
      await refresh(id);
      toast('success', mode === 'certificate' ? 'Document signed' : 'Signature added');
    } catch (error) {
      toast('error', 'Signing failed', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const readFile = (file: File, asDataUrl: boolean): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('The file could not be read.'));
      reader.onload = () => {
        const result = String(reader.result ?? '');
        resolve(asDataUrl ? result : result.replace(/^data:[^,]*,/, ''));
      };
      if (asDataUrl) reader.readAsDataURL(file);
      else reader.readAsDataURL(file);
    });

  return (
    <Modal
      title="Sign document"
      subtitle="Visible signatures, cryptographic signatures, or both."
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Close
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => void sign()}
            disabled={!id || busy || (mode === 'certificate' ? !p12 || !password : !image)}
          >
            {busy ? 'Signing…' : 'Sign'}
          </button>
        </>
      }
    >
      <Field label="Type">
        <Segmented<'draw' | 'certificate'>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'draw', label: 'Signature image' },
            { value: 'certificate', label: 'Certificate (PAdES)' },
          ]}
        />
      </Field>

      {mode === 'draw' ? (
        <Field label="Signature image" hint="PNG or JPEG with a transparent or white background.">
          <div className="row">
            <input
              type="file"
              accept="image/png,image/jpeg"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setImage(await readFile(file, true));
              }}
            />
            {image ? <img src={image} alt="signature preview" style={{ height: 44, background: '#fff', border: '1px solid var(--border)' }} /> : null}
          </div>
        </Field>
      ) : (
        <>
          <Field label="PKCS#12 keystore (.p12/.pfx)" hint="Nothing is uploaded; the certificate is used locally.">
            <div className="row">
              <input
                type="file"
                accept=".p12,.pfx"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setP12Name(file.name);
                  setP12(await readFile(file, false));
                }}
              />
              {p12Name ? <span className="muted small">{p12Name}</span> : null}
            </div>
          </Field>
          <div className="field-row">
            <Field label="Keystore password">
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" />
            </Field>
            <Field label="Signing reason">
              <input type="text" value={reason} onChange={(event) => setReason(event.target.value)} />
            </Field>
          </div>
          <p className="hint">
            Need a certificate? The toolkit can create a self-signed one for internal use — a public CA certificate is required
            for signatures that other organisations must trust.
          </p>
        </>
      )}

      <div className="field-row">
        <Field label="Page">
          <select value={pageIndex} onChange={(event) => setPageIndex(Number(event.target.value))}>
            {(entry?.info?.pages ?? []).map((item, index) => (
              <option key={index} value={index}>
                Page {index + 1}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Location (optional)">
          <input type="text" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Pune, IN" />
        </Field>
      </div>

      <BusyLabel busy={busy} />
      {verification ? <VerificationSummary verification={verification} /> : null}
    </Modal>
  );
}

export function VerificationSummary(props: { verification: SignatureVerification }): ReactElement {
  const { verification } = props;
  return (
    <div className="hint">
      <div className="row between" style={{ marginBottom: 6 }}>
        <strong className="row" style={{ gap: 6 }}>
          {verification.integrityOk ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />}
          {verification.integrityOk ? 'Integrity verified' : 'Integrity check failed'}
        </strong>
        <span className={`badge-pill ${verification.integrityOk ? 'good' : 'bad'}`}>{verification.algorithm ?? 'signature'}</span>
      </div>
      <div className="small">
        {verification.signerName ? <div>Signed by {verification.signerName}</div> : null}
        {verification.signingTime ? <div>Signed {new Date(verification.signingTime).toLocaleString()}</div> : null}
        {verification.selfSigned ? <div>Self-signed certificate — trusted only within your organisation.</div> : null}
        {verification.messages.map((message, index) => (
          <div key={index} className="muted">
            {message}
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                   */
/* -------------------------------------------------------------------------- */

export function RedactModal(): ReactElement {
  const { id, entry } = useActive();
  const { busy, runTask } = useTaskRunner();
  const setModal = useApp((state) => state.setModal);
  const refresh = useApp((state) => state.refresh);
  const toast = useApp((state) => state.toast);
  const [fill, setFill] = useState('#000000');
  const [scrub, setScrub] = useState(true);
  const [dpi, setDpi] = useState(200);
  const [verify, setVerify] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [outcome, setOutcome] = useState<{ pages: number; removed: number; verified: boolean } | null>(null);

  const marked = (entry?.annotations ?? []).filter((annotation: Annotation) => annotation.type === 'redact');
  const regions = useMemo(() => {
    const map = new Map<number, Rect[]>();
    for (const annotation of marked) {
      const list = map.get(annotation.pageIndex) ?? [];
      list.push(annotation.rect);
      map.set(annotation.pageIndex, list);
    }
    return [...map.entries()].map(([pageIndex, rects]) => ({ pageIndex, rects }));
  }, [marked]);

  const start = async (): Promise<void> => {
    if (!id || regions.length === 0) return;
    try {
      const result = await runTask((taskId) =>
        run(
          api.tools.redact(
            id,
            {
              regions,
              fill,
              scrubMetadata: scrub,
              dpi,
              verifyStrings: verify
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean),
            },
            taskId,
          ),
        ),
      );
      if (!result) return;
      setOutcome({ pages: result.pagesRedacted, removed: result.removedTextCount, verified: result.verified });
      await refresh(id);
      toast('success', 'Redaction applied', `${result.pagesRedacted} page(s) rewritten from scratch`);
    } catch (error) {
      toast('error', 'Redaction failed', errorMessage(error));
    }
  };

  return (
    <Modal
      title="Redact content"
      subtitle="Marked areas are removed from the page content — not merely covered."
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Close
          </button>
          <button type="button" className="button danger" onClick={() => void start()} disabled={!id || busy || regions.length === 0 || !confirmed}>
            {busy ? 'Redacting…' : 'Redact permanently'}
          </button>
        </>
      }
    >
      <div className="row between">
        <div>
          <strong>{marked.length}</strong> marked region{marked.length === 1 ? '' : 's'} on {regions.length} page{regions.length === 1 ? '' : 's'}
        </div>
        <button
          type="button"
          className="button"
          onClick={() => {
            useView.getState().setTool('redact');
            setModal(null);
          }}
        >
          <Download size={14} /> Mark areas on the page
        </button>
      </div>
      <p className="hint">
        Pick the <strong>Mark for redaction</strong> tool in the annotation bar and drag over anything that must disappear, then
        return here. Text underneath is deleted, images are clipped and the pages are re-written so nothing can be recovered.
      </p>
      <div className="field-row">
        <Field label="Box colour">
          <input type="color" value={fill} onChange={(event) => setFill(event.target.value)} />
        </Field>
        <Field label="Render DPI">
          <input type="number" min={96} max={400} value={dpi} onChange={(event) => setDpi(Number(event.target.value))} />
        </Field>
      </div>
      <Field label="Verify these strings are gone" hint="Comma separated. The result reports any string that still exists.">
        <input type="text" value={verify} onChange={(event) => setVerify(event.target.value)} placeholder="Jane Doe, 4111 1111 1111" />
      </Field>
      <Checkbox checked={scrub} onChange={setScrub} label="Also remove metadata and attachments" />
      <Checkbox checked={confirmed} onChange={setConfirmed} label="I understand redaction cannot be undone" />
      <BusyLabel busy={busy} />
      {outcome ? (
        <div className="hint">
          {outcome.pages} page(s) redacted, {outcome.removed} text run(s) removed.{' '}
          {outcome.verified ? 'All verification strings are gone.' : 'Some verification strings are still present — review the document.'}
        </div>
      ) : null}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Watermark / header-footer                                                   */
/* -------------------------------------------------------------------------- */

export function WatermarkModal(): ReactElement {
  const { id } = useActive();
  const setModal = useApp((state) => state.setModal);
  const refresh = useApp((state) => state.refresh);
  const toast = useApp((state) => state.toast);
  const fonts = useApp((state) => state.fonts);
  const [text, setText] = useState('CONFIDENTIAL');
  const [fontSize, setFontSize] = useState(54);
  const [color, setColor] = useState('#ff3b30');
  const [opacity, setOpacity] = useState(0.16);
  const [rotation, setRotation] = useState(45);
  const [tile, setTile] = useState(true);
  const [busy, setBusy] = useState(false);
  const fontFamily = useMemo(() => fonts.find((font) => font.unicode)?.family ?? 'Inter', [fonts]);

  const apply = async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await run(api.tools.watermark(id, { text, fontSize, color, opacity, rotation, x: 0.5, y: 0.5, tile, scale: 1, fontFamily }));
      await refresh(id);
      toast('success', 'Watermark applied');
      setModal(null);
    } catch (error) {
      toast('error', 'Watermark failed', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Watermark"
      subtitle="Every page, drawn on top of the content."
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => void apply()} disabled={!id || busy || !text.trim()}>
            Apply watermark
          </button>
        </>
      }
    >
      <Field label="Text">
        <input type="text" value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      <div className="field-row">
        <Field label="Size">
          <input type="number" min={4} max={400} value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} />
        </Field>
        <Field label="Colour">
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </Field>
        <Field label="Rotation">
          <input type="number" min={-180} max={180} value={rotation} onChange={(event) => setRotation(Number(event.target.value))} />
        </Field>
      </div>
      <Field label={`Opacity (${Math.round(opacity * 100)}%)`}>
        <input type="range" min={2} max={100} value={Math.round(opacity * 100)} onChange={(event) => setOpacity(Number(event.target.value) / 100)} />
      </Field>
      <Checkbox checked={tile} onChange={setTile} label="Repeat across the page" />
      <BusyLabel busy={busy} />
    </Modal>
  );
}

export function HeaderFooterModal(): ReactElement {
  const { id } = useActive();
  const setModal = useApp((state) => state.setModal);
  const refresh = useApp((state) => state.refresh);
  const toast = useApp((state) => state.toast);
  const fonts = useApp((state) => state.fonts);
  const [header, setHeader] = useState({ left: '', center: '{title}', right: '' });
  const [footer, setFooter] = useState({ left: '', center: 'Page {page} of {pages}', right: '{date}' });
  const [fontSize, setFontSize] = useState(9);
  const [firstPageNumber, setFirstPageNumber] = useState(1);
  const [busy, setBusy] = useState(false);
  const fontFamily = useMemo(() => fonts.find((font) => font.unicode)?.family ?? 'Inter', [fonts]);

  const apply = async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await run(
        api.tools.headerFooter(id, {
          headerLeft: header.left,
          headerCenter: header.center,
          headerRight: header.right,
          footerLeft: footer.left,
          footerCenter: footer.center,
          footerRight: footer.right,
          fontSize,
          color: '#333333',
          margin: 22,
          fontFamily,
          firstPageNumber,
          pageNumberFormat: '{page}',
          includeOnFirstPage: true,
        }),
      );
      await refresh(id);
      toast('success', 'Header and footer added');
      setModal(null);
    } catch (error) {
      toast('error', 'Could not add header/footer', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const tokenHint = 'Tokens: {title} {date} {page} {pages} {filename}';

  return (
    <Modal
      title="Header &amp; footer"
      subtitle={tokenHint}
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => void apply()} disabled={!id || busy}>
            Apply
          </button>
        </>
      }
    >
      <Field label="Header">
        <div className="field-row" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <input placeholder="Left" value={header.left} onChange={(event) => setHeader({ ...header, left: event.target.value })} />
          <input placeholder="Centre" value={header.center} onChange={(event) => setHeader({ ...header, center: event.target.value })} />
          <input placeholder="Right" value={header.right} onChange={(event) => setHeader({ ...header, right: event.target.value })} />
        </div>
      </Field>
      <Field label="Footer">
        <div className="field-row" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <input placeholder="Left" value={footer.left} onChange={(event) => setFooter({ ...footer, left: event.target.value })} />
          <input placeholder="Centre" value={footer.center} onChange={(event) => setFooter({ ...footer, center: event.target.value })} />
          <input placeholder="Right" value={footer.right} onChange={(event) => setFooter({ ...footer, right: event.target.value })} />
        </div>
      </Field>
      <div className="field-row">
        <Field label="Font size">
          <input type="number" min={5} max={36} value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} />
        </Field>
        <Field label="First page number">
          <input type="number" min={1} value={firstPageNumber} onChange={(event) => setFirstPageNumber(Number(event.target.value))} />
        </Field>
      </div>
      <p className="hint">{tokenHint}</p>
      <BusyLabel busy={busy} />
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Convert / export                                                            */
/* -------------------------------------------------------------------------- */

export function ConvertModal(): ReactElement {
  const { id, entry } = useActive();
  const { busy, runTask } = useTaskRunner();
  const setModal = useApp((state) => state.setModal);
  const toast = useApp((state) => state.toast);
  const [tab, setTab] = useState<'images' | 'text'>('images');
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(85);
  const [zip, setZip] = useState(false);
  const [grayscale, setGrayscale] = useState(false);
  const [exportFormat, setExportFormat] = useState<TextExportFormat>('txt');
  const [lastPath, setLastPath] = useState<string | null>(null);

  const exportImages = async (): Promise<void> => {
    if (!id) return;
    try {
      const outcome = await runTask((taskId) =>
        run(api.tools.exportImages(id, { format, dpi, quality, grayscale, zip, pages: null }, taskId)),
      );
      if (!outcome) return;
      setLastPath(outcome.zipPath ?? outcome.directory);
      toast('success', `Exported ${outcome.files.length} image(s)`, outcome.zipPath ?? outcome.directory);
    } catch (error) {
      toast('error', 'Export failed', errorMessage(error));
    }
  };

  const exportText = async (): Promise<void> => {
    if (!id) return;
    try {
      const result = await runTask(() => run(api.tools.exportText(id, exportFormat)));
      if (!result) return;
      setLastPath(result.path);
      toast('success', 'Text exported', result.path);
    } catch (error) {
      toast('error', 'Export failed', errorMessage(error));
    }
  };

  return (
    <Modal
      title="Convert &amp; export"
      subtitle={entry ? entry.summary.name : undefined}
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Close
          </button>
          <button type="button" className="button primary" onClick={() => void (tab === 'images' ? exportImages() : exportText())} disabled={!id || busy}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </>
      }
    >
      <Segmented<'images' | 'text'>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'images', label: 'Pages → images' },
          { value: 'text', label: 'Text → file' },
        ]}
      />
      {tab === 'images' ? (
        <>
          <Field label="Image format">
            <Segmented<'png' | 'jpeg'>
              value={format}
              onChange={setFormat}
              options={[
                { value: 'png', label: 'PNG (lossless)' },
                { value: 'jpeg', label: 'JPEG' },
              ]}
            />
          </Field>
          <div className="field-row">
            <Field label="DPI">
              <input type="number" min={36} max={600} value={dpi} onChange={(event) => setDpi(Number(event.target.value))} />
            </Field>
            <Field label="JPEG quality">
              <input type="number" min={1} max={100} value={quality} onChange={(event) => setQuality(Number(event.target.value))} />
            </Field>
          </div>
          <Checkbox checked={grayscale} onChange={setGrayscale} label="Grayscale output" />
          <Checkbox checked={zip} onChange={setZip} label="Pack into a ZIP archive" />
        </>
      ) : (
        <>
          <Field label="Text format">
            <Segmented<TextExportFormat>
              value={exportFormat}
              onChange={setExportFormat}
              options={[
                { value: 'txt', label: 'Plain text' },
                { value: 'markdown', label: 'Markdown' },
                { value: 'html', label: 'HTML' },
              ]}
            />
          </Field>
          <p className="hint">Text is extracted locally from the document&apos;s text layer. Scanned pages need OCR first.</p>
        </>
      )}
      <BusyLabel busy={busy} />
      {lastPath ? <p className="hint mono">{lastPath}</p> : null}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Split / merge                                                               */
/* -------------------------------------------------------------------------- */

export function SplitModal(): ReactElement {
  const { id, entry } = useActive();
  const setModal = useApp((state) => state.setModal);
  const toast = useApp((state) => state.toast);
  const [mode, setMode] = useState<'every' | 'ranges' | 'boundaries'>('every');
  const [every, setEvery] = useState(1);
  const [ranges, setRanges] = useState('1-2,3-4');
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<string[]>([]);

  const start = async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      const result = await run(api.tools.split(id, { mode, every, ranges }));
      setFiles(result.files);
      toast('success', `Created ${result.files.length} file(s)`);
    } catch (error) {
      toast('error', 'Split failed', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Split document"
      subtitle={entry ? `${entry.summary.pageCount} pages` : undefined}
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Close
          </button>
          <button type="button" className="button primary" onClick={() => void start()} disabled={!id || busy}>
            {busy ? 'Splitting…' : 'Split'}
          </button>
        </>
      }
    >
      <Segmented<'every' | 'ranges' | 'boundaries'>
        value={mode}
        onChange={setMode}
        options={[
          { value: 'every', label: 'Every N pages' },
          { value: 'ranges', label: 'Ranges' },
          { value: 'boundaries', label: 'At page breaks' },
        ]}
      />
      {mode === 'every' ? (
        <Field label="Pages per file">
          <input type="number" min={1} value={every} onChange={(event) => setEvery(Number(event.target.value))} />
        </Field>
      ) : null}
      {mode === 'ranges' ? (
        <Field label="Ranges" hint="Comma separated groups, e.g. 1-3,4-6,7">
          <input type="text" value={ranges} onChange={(event) => setRanges(event.target.value)} />
        </Field>
      ) : null}
      {mode === 'boundaries' ? <p className="hint">The document is split at every bookmark that starts a new page.</p> : null}
      <BusyLabel busy={busy} />
      {files.length ? (
        <div className="stack">
          {files.slice(0, 12).map((file) => (
            <div key={file} className="mono small muted">
              {file}
            </div>
          ))}
          {files.length > 12 ? <div className="small muted">…and {files.length - 12} more</div> : null}
        </div>
      ) : null}
    </Modal>
  );
}

export function MergeModal(): ReactElement {
  const order = useApp((state) => state.order);
  const docs = useApp((state) => state.docs);
  const absorb = useApp((state) => state.absorb);
  const setModal = useApp((state) => state.setModal);
  const toast = useApp((state) => state.toast);
  const [selected, setSelected] = useState<string[]>(order);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string): void => {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const merge = async (): Promise<void> => {
    if (selected.length < 2) return;
    setBusy(true);
    try {
      const summary = await run(api.tools.merge({ documentIds: selected, keepOriginalOpen: true }));
      await absorb({ id: summary.id, summary });
      toast('success', 'Documents merged', `${summary.pageCount} pages`);
      setModal(null);
    } catch (error) {
      toast('error', 'Merge failed', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Merge documents"
      subtitle="The selected documents are combined in the order shown."
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => void merge()} disabled={selected.length < 2 || busy}>
            {busy ? 'Merging…' : `Merge ${selected.length} documents`}
          </button>
        </>
      }
    >
      {order.length === 0 ? (
        <p className="hint">Open at least two documents first. Use Ctrl+O to add files.</p>
      ) : (
        order.map((id) => (
          <label key={id} className="checkbox" style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 8 }}>
            <input type="checkbox" checked={selected.includes(id)} onChange={() => toggle(id)} />
            <span style={{ flex: 1 }}>
              {docs[id]?.summary.name}{' '}
              <span className="muted small">
                · {docs[id]?.summary.pageCount ?? 0} pages
              </span>
            </span>
            <span className="badge-pill">{selected.indexOf(id) >= 0 ? selected.indexOf(id) + 1 : '—'}</span>
          </label>
        ))
      )}
      <BusyLabel busy={busy} />
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Forms                                                                       */
/* -------------------------------------------------------------------------- */

export function FormsModal(): ReactElement {
  const { id, entry } = useActive();
  const setModal = useApp((state) => state.setModal);
  const refresh = useApp((state) => state.refresh);
  const toast = useApp((state) => state.toast);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const fields = entry?.info?.formFields ?? [];

  useEffect(() => {
    const initial: Record<string, string | boolean> = {};
    for (const field of fields) {
      initial[field.name] = typeof field.value === 'boolean' ? field.value : String(field.value ?? '');
    }
    setValues(initial);
  }, [fields]);

  const submit = async (flatten: boolean): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      const payload: Record<string, { type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionlist'; value: string | boolean }> = {};
      for (const field of fields) {
        const type =
          field.type === 'checkbox' || field.type === 'radio' || field.type === 'dropdown' || field.type === 'optionlist'
            ? field.type
            : 'text';
        payload[field.name] = { type, value: values[field.name] ?? '' };
      }
      await run(api.tools.formsFill(id, payload, flatten));
      await refresh(id);
      toast('success', flatten ? 'Forms filled and flattened' : 'Form values saved');
      setModal(null);
    } catch (error) {
      toast('error', 'Could not fill the form', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Form fields"
      subtitle={fields.length ? `${fields.length} field(s)` : 'This document has no form fields.'}
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Close
          </button>
          <button type="button" className="button" onClick={() => void submit(false)} disabled={!fields.length || busy}>
            Save values
          </button>
          <button type="button" className="button primary" onClick={() => void submit(true)} disabled={!fields.length || busy}>
            Save &amp; flatten
          </button>
        </>
      }
    >
      {fields.map((field) => (
        <Field key={field.name} label={`${field.name}${field.required ? ' *' : ''}`} hint={field.type}>
          {field.type === 'checkbox' ? (
            <input
              type="checkbox"
              checked={Boolean(values[field.name])}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.checked })}
            />
          ) : field.options?.length ? (
            <select
              value={String(values[field.name] ?? '')}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            >
              <option value="">—</option>
              {field.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={String(values[field.name] ?? '')}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            />
          )}
        </Field>
      ))}
      <BusyLabel busy={busy} />
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Metadata & outline                                                          */
/* -------------------------------------------------------------------------- */

export function MetadataModal(): ReactElement {
  const { id, entry } = useActive();
  const setModal = useApp((state) => state.setModal);
  const refresh = useApp((state) => state.refresh);
  const toast = useApp((state) => state.toast);
  const [title, setTitle] = useState(entry?.info?.metadata.title ?? '');
  const [author, setAuthor] = useState(entry?.info?.metadata.author ?? '');
  const [subject, setSubject] = useState(entry?.info?.metadata.subject ?? '');
  const [keywords, setKeywords] = useState((entry?.info?.metadata.keywords ?? []).join(', '));
  const [outline, setOutline] = useState<{ title: string; pageIndex: number | null; children: { title: string; pageIndex: number | null }[] }[]>(
    (entry?.info?.outline ?? []).map((item) => ({
      title: item.title,
      pageIndex: item.pageIndex,
      children: item.children.map((child) => ({ title: child.title, pageIndex: child.pageIndex })),
    })),
  );
  const [busy, setBusy] = useState(false);

  const apply = async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await run(
        api.tools.setMetadata(id, {
          title,
          author,
          subject,
          keywords: keywords.split(',').map((value) => value.trim()).filter(Boolean),
        }),
      );
      await run(api.tools.setOutline(id, outline));
      await refresh(id);
      toast('success', 'Document properties saved');
      setModal(null);
    } catch (error) {
      toast('error', 'Could not save the properties', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Document properties"
      subtitle="Metadata and bookmarks are embedded in the file."
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={() => void apply()} disabled={!id || busy}>
            Save
          </button>
        </>
      }
    >
      <div className="field-row">
        <Field label="Title">
          <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Author">
          <input type="text" value={author} onChange={(event) => setAuthor(event.target.value)} />
        </Field>
      </div>
      <Field label="Subject">
        <input type="text" value={subject} onChange={(event) => setSubject(event.target.value)} />
      </Field>
      <Field label="Keywords" hint="Comma separated">
        <input type="text" value={keywords} onChange={(event) => setKeywords(event.target.value)} />
      </Field>
      <div className="stack">
        <span className="field-label">Bookmarks</span>
        {outline.length === 0 ? <p className="muted small">No bookmarks yet.</p> : null}
        {outline.map((item, index) => (
          <div key={index} className="row" style={{ gap: 6 }}>
            <input
              type="text"
              value={item.title}
              onChange={(event) => {
                const next = [...outline];
                next[index] = { ...item, title: event.target.value };
                setOutline(next);
              }}
            />
            <input
              type="number"
              min={1}
              style={{ width: 78 }}
              value={(item.pageIndex ?? 0) + 1}
              onChange={(event) => {
                const next = [...outline];
                next[index] = { ...item, pageIndex: Math.max(0, Number(event.target.value) - 1) };
                setOutline(next);
              }}
            />
            <button type="button" className="icon-button" onClick={() => setOutline(outline.filter((_, position) => position !== index))} title="Remove">
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button"
          onClick={() => setOutline([...outline, { title: `Chapter ${outline.length + 1}`, pageIndex: 0, children: [] }])}
        >
          Add bookmark
        </button>
      </div>
      <BusyLabel busy={busy} />
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Print                                                                       */
/* -------------------------------------------------------------------------- */

export function PrintModal(): ReactElement {
  const { id, entry } = useActive();
  const setModal = useApp((state) => state.setModal);
  const toast = useApp((state) => state.toast);
  const settings = useApp((state) => state.settings);
  const [printers, setPrinters] = useState<{ name: string; isDefault: boolean }[]>([]);
  const [printerName, setPrinterName] = useState('');
  const [copies, setCopies] = useState(1);
  const [pages, setPages] = useState('');
  const [landscape, setLandscape] = useState(false);
  const [color, setColor] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void attempt(api.print.printers()).then((list) => {
      setPrinters(list ?? []);
      setPrinterName(list?.find((printer) => printer.isDefault)?.name ?? list?.[0]?.name ?? '');
    });
  }, []);

  const print = async (silent: boolean): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      const result = await run(
        api.print.print(id, {
          ...(printerName ? { printerName } : {}),
          silent,
          copies,
          ...(pages ? { pages } : {}),
          landscape,
          color,
          scale: settings?.printScale ?? 'fit',
        }),
      );
      toast('success', result.printed ? 'Sent to printer' : 'Print cancelled', result.printerName);
      setModal(null);
    } catch (error) {
      toast('error', 'Printing failed', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Print"
      subtitle={entry ? entry.summary.name : undefined}
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button" onClick={() => void print(false)} disabled={!id || busy}>
            Printer dialog…
          </button>
          <button type="button" className="button primary" onClick={() => void print(true)} disabled={!id || busy || !printerName}>
            {busy ? 'Printing…' : 'Print'}
          </button>
        </>
      }
    >
      <Field label="Printer">
        <select value={printerName} onChange={(event) => setPrinterName(event.target.value)}>
          {printers.length === 0 ? <option value="">No printers found</option> : null}
          {printers.map((printer) => (
            <option key={printer.name} value={printer.name}>
              {printer.name}
              {printer.isDefault ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <div className="field-row">
        <Field label="Copies">
          <input type="number" min={1} max={99} value={copies} onChange={(event) => setCopies(Number(event.target.value))} />
        </Field>
        <Field label="Pages" hint="Empty = all. Example 1-3,7">
          <input type="text" value={pages} onChange={(event) => setPages(event.target.value)} />
        </Field>
      </div>
      <Checkbox checked={landscape} onChange={setLandscape} label="Landscape" />
      <Checkbox checked={color} onChange={setColor} label="Colour" />
      <p className="hint">
        Printing uses the same rendering engine as the viewer, so what you see is what the printer receives.
      </p>
      <BusyLabel busy={busy} />
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* New document                                                                */
/* -------------------------------------------------------------------------- */

const PAGE_SIZES: { value: PageSizeName; label: string }[] = [
  { value: 'A4', label: 'A4 (210 × 297 mm)' },
  { value: 'Letter', label: 'Letter (8.5 × 11 in)' },
  { value: 'Legal', label: 'Legal (8.5 × 14 in)' },
  { value: 'A3', label: 'A3' },
  { value: 'A5', label: 'A5' },
];

export function NewDocumentModal(): ReactElement {
  const setModal = useApp((state) => state.setModal);
  const createDocument = useApp((state) => state.createDocument);
  const createFromText = useApp((state) => state.createFromText);
  const createFromImages = useApp((state) => state.createFromImages);
  const settings = useApp((state) => state.settings);
  const toast = useApp((state) => state.toast);
  const [tab, setTab] = useState<'blank' | 'text' | 'images'>('blank');
  const [pageSize, setPageSize] = useState<PageSizeName>(settings?.defaultPageSize ?? 'A4');
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>(settings?.defaultOrientation ?? 'portrait');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('Untitled document');
  const [fontSize, setFontSize] = useState(11);
  const [images, setImages] = useState<{ name: string; dataUrl: string }[]>([]);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      title="New PDF"
      onClose={() => setModal(null)}
      footer={
        <>
          <button type="button" className="button" onClick={() => setModal(null)} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={busy || (tab === 'text' && !text.trim()) || (tab === 'images' && images.length === 0)}
            onClick={async () => {
              setBusy(true);
              if (tab === 'blank') await createDocument({ pageSize, orientation });
              else if (tab === 'text')
                await createFromText({
                  title,
                  text,
                  pageSize,
                  orientation,
                  fontSize,
                  fontFamily: 'Inter',
                  margin: 56,
                  lineHeight: 1.45,
                });
              else
                await createFromImages({
                  images,
                  pageSize,
                  orientation,
                  margin: 24,
                  onePerPage: true,
                });
              setBusy(false);
            }}
          >
            Create
          </button>
        </>
      }
    >
      <Segmented<'blank' | 'text' | 'images'>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'blank', label: 'Blank' },
          { value: 'text', label: 'From text' },
          { value: 'images', label: 'From images' },
        ]}
      />
      <div className="field-row">
        <Field label="Page size">
          <select value={pageSize} onChange={(event) => setPageSize(event.target.value as PageSizeName)}>
            {PAGE_SIZES.map((size) => (
              <option key={size.value} value={size.value}>
                {size.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Orientation">
          <Segmented<'portrait' | 'landscape'>
            value={orientation}
            onChange={setOrientation}
            options={[
              { value: 'portrait', label: 'Portrait' },
              { value: 'landscape', label: 'Landscape' },
            ]}
          />
        </Field>
      </div>
      {tab === 'text' ? (
        <>
          <Field label="Title">
            <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label="Text" hint="Paste or type content. Line breaks start new lines; long text flows onto new pages.">
            <textarea value={text} onChange={(event) => setText(event.target.value)} style={{ minHeight: 220 }} />
          </Field>
          <Field label="Font size">
            <input type="number" min={6} max={48} value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))} />
          </Field>
        </>
      ) : null}
      {tab === 'images' ? (
        <Field label="Images" hint="PNG, JPEG or WebP. Each image becomes its own page.">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={async (event) => {
              const files = Array.from(event.target.files ?? []);
              const loaded: { name: string; dataUrl: string }[] = [];
              for (const file of files) {
                const dataUrl = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result));
                  reader.onerror = () => reject(new Error('read failed'));
                  reader.readAsDataURL(file);
                }).catch(() => null);
                if (dataUrl) loaded.push({ name: file.name, dataUrl });
              }
              if (!loaded.length) toast('error', 'No images could be read');
              setImages(loaded);
            }}
          />
        </Field>
      ) : null}
      <BusyLabel busy={busy} />
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Recovery                                                                    */
/* -------------------------------------------------------------------------- */

export function RecoveryModal(): ReactElement {
  const setModal = useApp((state) => state.setModal);
  const absorb = useApp((state) => state.absorb);
  const toast = useApp((state) => state.toast);
  const [entries, setEntries] = useState<{ path: string; name: string; modified: string }[]>([]);

  useEffect(() => {
    void attempt(api.recovery.list()).then((list) => setEntries(list ?? []));
  }, []);

  return (
    <Modal
      title="Recover unsaved work"
      subtitle="These snapshots were written automatically before the last exit."
      onClose={() => setModal(null)}
      footer={
        <>
          <button
            type="button"
            className="button danger"
            onClick={async () => {
              for (const entry of entries) await attempt(api.recovery.discard(entry.path));
              setEntries([]);
              setModal(null);
            }}
          >
            Discard all
          </button>
          <button type="button" className="button" onClick={() => setModal(null)}>
            Later
          </button>
        </>
      }
    >
      {entries.length === 0 ? <p className="muted">Nothing to recover.</p> : null}
      {entries.map((entry) => (
        <div key={entry.path} className="list-row">
          <div className="row-main">
            <div className="row-title">{entry.name}</div>
            <div className="row-sub">{new Date(entry.modified).toLocaleString()}</div>
          </div>
          <button
            type="button"
            className="button"
            onClick={async () => {
              try {
                const handle = await run(api.recovery.restore(entry.path));
                await absorb(handle);
                setEntries(entries.filter((item) => item.path !== entry.path));
                toast('success', 'Snapshot restored', 'Save the document to keep it.');
              } catch (error) {
                toast('error', 'Could not restore the snapshot', errorMessage(error));
              }
            }}
          >
            <FileDown size={14} /> Restore
          </button>
        </div>
      ))}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
