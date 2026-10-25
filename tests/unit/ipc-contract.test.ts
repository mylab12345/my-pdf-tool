import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC, IPC_EVENTS } from '../../src/shared/ipc';
import { repoRoot } from './helpers';

/**
 * Static contract test for the IPC surface.
 *
 * The renderer can only reach the main process through channels that are both
 * exposed by the preload bridge and handled in the main process. This test
 * compares the two lists, which is exactly the class of bug that would otherwise
 * only show up as a "No handler registered" runtime error in production.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const channelValues = new Map<string, string>();
for (const [group, entries] of Object.entries(IPC)) {
  for (const [key, value] of Object.entries(entries as Record<string, string>)) {
    channelValues.set(`${group}.${key}`, value);
  }
}

const preloadSource = readFileSync(path.join(repoRoot, 'src/preload/index.ts'), 'utf8');
const mainSources = walk(path.join(repoRoot, 'src/main'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('IPC contract', () => {
  it('registers a main-process handler for every channel the preload exposes', () => {
    const exposed = [...preloadSource.matchAll(/IPC\.(\w+)\.(\w+)/g)].map((match) => `${match[1]}.${match[2]}`);
    expect(exposed.length).toBeGreaterThan(40);

    const missing = exposed.filter((key) => {
      const channel = channelValues.get(key);
      if (!channel) return true;
      // Handlers are registered either via the typed helper (`handle(IPC.x.y)`)
      // or directly with the channel string (window/recovery helpers).
      return !mainSources.includes(`handle(IPC.${key}`) && !mainSources.includes(`'${channel}'`);
    });

    expect(missing, `channels without a main handler: ${missing.join(', ')}`).toEqual([]);
  });

  it('never registers the same channel twice', () => {
    const registrations = [...mainSources.matchAll(/handle\(IPC\.(\w+)\.(\w+)/g)].map((match) => channelValues.get(`${match[1]}.${match[2]}`)!);
    const direct = [...mainSources.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((match) => match[1]!);
    const all = [...registrations, ...direct];
    const duplicates = all.filter((channel, index) => all.indexOf(channel) !== index);
    expect(duplicates).toEqual([]);
  });

  it('keeps every IPC channel name unique', () => {
    const values = [...channelValues.values()];
    expect(new Set(values).size).toBe(values.length);
  });

  it('uses a namespaced event channel for every main-to-renderer push', () => {
    for (const [key, channel] of Object.entries(IPC_EVENTS)) {
      expect(channel.startsWith('event:')).toBe(true);
      // The main process must actually emit it; the preload must subscribe.
      expect(mainSources.includes(`IPC_EVENTS.${key}`), `main never emits ${key}`).toBe(true);
      expect(preloadSource.includes(`IPC_EVENTS.${key}`), `preload never subscribes to ${key}`).toBe(true);
    }
  });

  it('exposes an event subscription for each pushed event', () => {
    const subscriptions = [...preloadSource.matchAll(/subscribe<[^>]+>\(IPC_EVENTS\.(\w+)/g)].map((match) => match[1]);
    expect(subscriptions.sort()).toEqual(
      ['documentChanged', 'menuCommand', 'openFileRequest', 'recoveryAvailable', 'taskProgress', 'windowState'].sort(),
    );
  });
});
