import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { useApp, useView, type DocEntry } from '../../src/renderer/store';
import type { PdfInfo } from '../../src/shared/types';

/**
 * Renderer smoke tests.
 *
 * They render the real application shell against the same preload contract the
 * Electron build uses. The goal is to catch wiring mistakes (missing handlers,
 * broken store transitions, dialogs that never open) before the packaged app is
 * built — the PDF rasterisation itself is covered by the engine tests.
 */

const info: PdfInfo = {
  fileSize: 4096,
  pageCount: 2,
  pages: [
    { index: 0, width: 595.28, height: 841.89, rotation: 0, hasText: true },
    { index: 1, width: 595.28, height: 841.89, rotation: 0, hasText: true },
  ],
  metadata: { title: 'Fixture', author: 'QA' },
  encrypted: false,
  hasForms: false,
  formFields: [],
  hasSignatures: false,
  outline: [{ title: 'Chapter one', pageIndex: 0, children: [] }],
  attachments: [],
  textCharacters: 1200,
};

function seedDocument(): void {
  const entry: DocEntry = {
    summary: {
      id: 'doc-1',
      path: '/docs/fixture.pdf',
      name: 'fixture.pdf',
      pageCount: 2,
      fileSize: 4096,
      dirty: false,
      encrypted: false,
      canUndo: true,
      canRedo: false,
      undoLabel: 'Rotate page',
    },
    info,
    annotations: [
      {
        id: 'ann-1',
        type: 'note',
        pageIndex: 0,
        rect: { x: 100, y: 600, width: 16, height: 16 },
        color: '#f5c542',
        opacity: 1,
        icon: 'Note',
        contents: 'Review this',
        editable: true,
      },
    ],
    revision: 1,
  };
  useApp.setState({ ready: true, docs: { 'doc-1': entry }, order: ['doc-1'], activeId: 'doc-1' });
}

beforeEach(() => {
  useApp.setState({
    ready: true,
    docs: {},
    order: [],
    activeId: null,
    modal: null,
    tasks: {},
    toasts: [],
    busy: null,
  });
  useView.setState({ sidebarOpen: true, tab: 'thumbnails', tool: 'select', fit: 'width', zoom: 1.15, currentPage: 0 });
});

describe('application shell', () => {
  it('shows the welcome screen and offers the creation entry points', async () => {
    render(<App />);
    expect(await screen.findByText('Arena PDF Studio')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Open PDF/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /New PDF/i }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Local & private/i)).toBeTruthy();
  });

  it('opens the new-document dialog and creates a blank PDF through the bridge', async () => {
    render(<App />);
    const newButtons = await screen.findAllByRole('button', { name: /New PDF/i });
    fireEvent.click(newButtons[0]!);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'New PDF' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(window.arena.documents.create).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 'A4', orientation: 'portrait' }),
      );
    });
  });

  it('renders the document title, sidebar tabs and status bar for an open document', async () => {
    seedDocument();
    render(<App />);
    expect(await screen.findByText('fixture.pdf')).toBeTruthy();
    expect(screen.getByText(/Page 1 of 2/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Pages/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Contents/i })).toBeTruthy();
  });

  it('lists annotations in the notes panel and can delete them', async () => {
    seedDocument();
    render(<App />);
    fireEvent.click(await screen.findByRole('tab', { name: /Notes/i }));
    expect(await screen.findByText('Review this')).toBeTruthy();
    const apply = vi.spyOn(window.arena.documents, 'apply');
    fireEvent.click(screen.getByTitle('Delete annotation'));
    await waitFor(() => expect(apply).toHaveBeenCalled());
    expect(apply.mock.calls[0]?.[1]).toEqual([{ kind: 'removeAnnotation', id: 'ann-1' }]);
  });

  it('opens the settings dialog and persists changes', async () => {
    render(<App />);
    useApp.getState().setModal('settings');
    expect(await screen.findByText('Settings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Save settings/i }));
    await waitFor(() => expect(window.arena.app.updateSettings).toHaveBeenCalled());
  });

  it('routes OCR, compression and signature tools to their dialogs', async () => {
    seedDocument();
    render(<App />);
    for (const [modal, heading] of [
      ['ocr', 'Recognise text'],
      ['compress', 'Compress document'],
      ['sign', 'Sign document'],
      ['redact', 'Redact content'],
      ['watermark', 'Watermark'],
      ['convert', 'Convert & export'],
      ['split', 'Split document'],
      ['print', 'Print'],
      ['metadata', 'Document properties'],
      ['forms', 'Form fields'],
    ] as const) {
      useApp.getState().setModal(modal);
      const title = await screen.findByRole('heading', { name: new RegExp(heading, 'i') });
      expect(title).toBeTruthy();
      useApp.getState().setModal(null);
    }
  });

  it('shows task progress and lets the user cancel it', async () => {
    seedDocument();
    render(<App />);
    useApp.getState().setTask({
      taskId: 'task-1',
      label: 'Recognising page 1',
      completed: 1,
      total: 4,
      percent: 25,
      cancellable: true,
    });
    expect(await screen.findByText('Recognising page 1')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Cancel'));
    await waitFor(() => expect(window.arena.app.cancelTask).toHaveBeenCalledWith('task-1'));
  });

  it('reports failures as toasts instead of throwing', async () => {
    render(<App />);
    useApp.getState().toast('error', 'Could not open the file', 'The file is damaged');
    expect(await screen.findByText('Could not open the file')).toBeTruthy();
    expect(screen.getByText('The file is damaged')).toBeTruthy();
  });
});
