import { describe, expect, it } from 'vitest';
import { canInstall, type InstallRecord } from '../server/pilot/component-install.ts';

describe('canInstall (PS-6 pilot)', () => {
  it('allows a never-installed component', () => {
    const installs: InstallRecord[] = [{ componentId: 'other', bikeId: 'A' }];
    expect(canInstall('c1', 'B', installs)).toEqual({ allowed: true });
  });

  it('rejects a component actively installed on another bike', () => {
    expect(canInstall('c1', 'B', [{ componentId: 'c1', bikeId: 'A' }])).toEqual({ allowed: false, reason: 'installed-elsewhere' });
  });

  it('allows a component removed from another bike', () => {
    expect(canInstall('c1', 'B', [{ componentId: 'c1', bikeId: 'A', removedAt: '2026-01-01T00:00:00Z' }])).toEqual({ allowed: true });
  });

  it('rejects a duplicate install on the same target bike', () => {
    expect(canInstall('c1', 'B', [{ componentId: 'c1', bikeId: 'B' }])).toEqual({ allowed: false, reason: 'duplicate' });
  });

  it('allows when history is empty', () => {
    expect(canInstall('c1', 'B', [])).toEqual({ allowed: true });
  });

  it('does not mutate its input', () => {
    const installs: InstallRecord[] = [
      { componentId: 'c1', bikeId: 'A', removedAt: '2026-01-01T00:00:00Z' },
      { componentId: 'c1', bikeId: 'B' },
    ];
    const before = structuredClone(installs);
    canInstall('c1', 'C', installs);
    expect(installs).toEqual(before);
  });
});
