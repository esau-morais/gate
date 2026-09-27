import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type RecordedPnpmLock =
  | 'vuejs-core'
  | 'rules-js-v54'
  | 'rules-js-v60'
  | 'rules-js-v61'
  | 'rules-js-v90'
  | 'rules-js-v101'
  | 'rules-js-v110'
  | 'rules-js-v120'
  | 'rules-js-multi-document-v11';

export function recordedPnpmLockPath(name: RecordedPnpmLock): string {
  return fileURLToPath(new URL(`./${name}.pnpm-lock.yaml`, import.meta.url));
}

export function recordedPnpmLock(name: RecordedPnpmLock): string {
  return readFileSync(recordedPnpmLockPath(name), 'utf8');
}

export type RecordedPnpmWorkspace =
  'rules-js' | 'seek-oss-wingman' | 'quests-org-quests';

export function recordedPnpmWorkspacePath(name: RecordedPnpmWorkspace): string {
  return fileURLToPath(
    new URL(`./${name}.pnpm-workspace.yaml`, import.meta.url),
  );
}

export function recordedPnpmWorkspace(name: RecordedPnpmWorkspace): string {
  return readFileSync(recordedPnpmWorkspacePath(name), 'utf8');
}
