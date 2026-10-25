import { app } from 'electron';
import { start } from './app';

/**
 * Electron entry point.
 *
 * Kept deliberately tiny: everything lives in `app.ts` so the startup sequence
 * can be read in one place. `app.setName` and the AppUserModelID are set before
 * anything else so Windows taskbar grouping, jump lists and the installer's
 * shortcut all agree on the application identity.
 */

app.setName('Arena PDF Studio');
if (process.platform === 'win32') {
  app.setAppUserModelId('in.arena.pdfstudio');
}

// The renderer is fully local; block every remote request as a safety net.
app.commandLine.appendSwitch('disable-features', 'MediaRouter,OptimizationHints');
app.commandLine.appendSwitch('enable-features', 'PdfOopif');

start();
