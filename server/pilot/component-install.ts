// PS-6 pilot: pure component-installation eligibility rule. No I/O, no mutation of inputs.
// An install record is active until it has a removal timestamp.
export interface InstallRecord {
  componentId: string;
  bikeId: string;
  removedAt?: string | null;
}

export type InstallDecision =
  | { allowed: true }
  | { allowed: false; reason: 'duplicate' | 'installed-elsewhere' };

export function canInstall(componentId: string, targetBikeId: string, installs: readonly InstallRecord[]): InstallDecision {
  const active = installs.find((r) => r.componentId === componentId && r.removedAt == null);
  if (!active) return { allowed: true };
  return { allowed: false, reason: active.bikeId === targetBikeId ? 'duplicate' : 'installed-elsewhere' };
}
