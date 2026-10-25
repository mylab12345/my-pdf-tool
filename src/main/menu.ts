import { Menu, app, type MenuItemConstructorOptions, type BrowserWindow } from 'electron';
import type { MenuCommand } from '../shared/ipc';
import type { RecentFile } from '../shared/types';

/**
 * Native application menu.
 *
 * Every item dispatches a `MenuCommand` to the focused window instead of doing
 * work itself, so the renderer stays the single place that owns document state.
 * Accelerators follow the platform conventions (`Cmd` on macOS is not a target,
 * but the menu is still correct there) and are shown in the UI cheat sheet.
 */

export interface MenuOptions {
  send(command: MenuCommand): void;
  openRecent(path: string): void;
  clearRecent(): void;
  recentFiles: RecentFile[];
  isDev: boolean;
  getWindow(): BrowserWindow | null;
}

const isMac = process.platform === 'darwin';

export function buildApplicationMenu(options: MenuOptions): Menu {
  const item = (
    label: string,
    command: MenuCommand,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => options.send(command),
  });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: '&File',
      submenu: [
        item('New PDF', 'file:new', 'CmdOrCtrl+N'),
        item('Open…', 'file:open', 'CmdOrCtrl+O'),
        {
          label: 'Open Recent',
          enabled: options.recentFiles.length > 0,
          submenu: [
            ...options.recentFiles.slice(0, 15).map(
              (recent): MenuItemConstructorOptions => ({
                label: `${recent.name} — ${recent.path}`,
                click: () => options.openRecent(recent.path),
              }),
            ),
            ...(options.recentFiles.length
              ? ([{ type: 'separator' }, { label: 'Clear Menu', click: () => options.clearRecent() }] satisfies MenuItemConstructorOptions[])
              : []),
          ],
        },
        { type: 'separator' },
        item('Save', 'file:save', 'CmdOrCtrl+S'),
        item('Save As…', 'file:saveAs', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        item('Print…', 'file:print', 'CmdOrCtrl+P'),
        { type: 'separator' },
        item('Close Document', 'file:close', 'CmdOrCtrl+W'),
        ...(isMac ? [] : [item('Exit', 'file:close', 'Alt+F4')]),
      ],
    },
    {
      label: '&Edit',
      submenu: [
        item('Undo', 'edit:undo', 'CmdOrCtrl+Z'),
        item('Redo', 'edit:redo', 'CmdOrCtrl+Shift+Z'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        item('Find in Document…', 'edit:find', 'CmdOrCtrl+F'),
        item('Delete Selected Annotations', 'edit:delete-annotations', 'Delete'),
      ],
    },
    {
      label: '&View',
      submenu: [
        item('Zoom In', 'view:zoom-in', 'CmdOrCtrl+='),
        item('Zoom Out', 'view:zoom-out', 'CmdOrCtrl+-'),
        item('Fit Width', 'view:fit-width', 'CmdOrCtrl+1'),
        item('Fit Page', 'view:fit-page', 'CmdOrCtrl+0'),
        { type: 'separator' },
        item('Rotate Left', 'view:rotate-left', 'CmdOrCtrl+['),
        item('Rotate Right', 'view:rotate-right', 'CmdOrCtrl+]'),
        { type: 'separator' },
        item('Toggle Sidebar', 'view:sidebar', 'CmdOrCtrl+B'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(options.isDev
          ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: '&Tools',
      submenu: [
        item('Recognise Text (OCR)…', 'tools:ocr'),
        item('Compress…', 'tools:compress'),
        item('Encrypt / Permissions…', 'tools:encrypt'),
        item('Convert…', 'tools:convert'),
        { type: 'separator' },
        item('Sign…', 'tools:sign'),
        item('Redact…', 'tools:redact'),
        item('Watermark…', 'tools:watermark'),
        { type: 'separator' },
        item('Forms…', 'tools:forms'),
        item('Merge Documents…', 'tools:merge'),
        item('Split Document…', 'tools:split'),
        { type: 'separator' },
        item('Settings…', 'tools:settings', 'CmdOrCtrl+,')
      ],
    },
    {
      label: '&Help',
      submenu: [
        item('Keyboard Shortcuts', 'help:shortcuts', 'F1'),
        item('About Arena PDF Studio', 'help:about'),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

export function installApplicationMenu(options: MenuOptions): Menu {
  const menu = buildApplicationMenu(options);
  Menu.setApplicationMenu(menu);
  return menu;
}
