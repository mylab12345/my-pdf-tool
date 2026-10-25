import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { FilePlus2, FolderOpen, ImagePlus, FileText, ShieldCheck, WifiOff } from 'lucide-react';
import type { RecentFile } from '../../shared/types';
import { api } from '../lib/bridge';
import { useApp } from '../store';

/**
 * Empty state shown when no document is open.
 *
 * It doubles as the start screen: recent files, the four creation entry points
 * and a reminder that nothing leaves the machine.
 */
export function WelcomeScreen(): ReactElement {
  const setModal = useApp((state) => state.setModal);
  const openDialog = useApp((state) => state.openDialog);
  const openPath = useApp((state) => state.openPath);
  const environment = useApp((state) => state.environment);
  const [recent, setRecent] = useState<RecentFile[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api.app.recentFiles().then((result) => {
      if (!cancelled && result.ok) setRecent(result.value.slice(0, 12));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="viewer-empty">
      <div className="welcome">
        <div>
          <h1>Arena PDF Studio</h1>
          <p>
            Create, edit, annotate, OCR, sign, encrypt, compress, merge and split PDF files — entirely on this
            computer. Nothing is uploaded and no account is required.
          </p>
          <div className="welcome-actions">
            <button type="button" className="button primary" onClick={() => void openDialog()}>
              <FolderOpen size={15} /> Open PDF
            </button>
            <button type="button" className="button" onClick={() => setModal('newDocument')}>
              <FilePlus2 size={15} /> New PDF
            </button>
            <button type="button" className="button" onClick={() => setModal('newDocument')}>
              <FileText size={15} /> From text
            </button>
            <button type="button" className="button" onClick={() => setModal('merge')}>
              <ImagePlus size={15} /> Merge files
            </button>
          </div>
          <div className="row" style={{ marginTop: 22, gap: 14, flexWrap: 'wrap' }}>
            <span className="badge-pill good">
              <ShieldCheck size={12} /> Local &amp; private
            </span>
            <span className="badge-pill">
              <WifiOff size={12} /> Works offline
            </span>
            {environment ? (
              <span className="badge-pill">
                {environment.platform.split(' ')[0]} · {environment.arch}
              </span>
            ) : null}
          </div>
          <p className="hint" style={{ marginTop: 20 }}>
            Tip: drop PDF files anywhere in this window to open them. Everything you change stays in memory until you
            press Ctrl+S.
          </p>
        </div>

        <div className="welcome-section">
          <h3>Recent documents</h3>
          {recent.length === 0 ? (
            <p className="muted small" style={{ margin: 0 }}>
              Files you open will be listed here. The list never leaves this machine.
            </p>
          ) : (
            <div className="recent-list">
              {recent.map((file) => (
                <button key={file.path} type="button" className="recent-item" onClick={() => void openPath(file.path)} title={file.path}>
                  <strong>{file.name}</strong>
                  <span>{file.path}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
