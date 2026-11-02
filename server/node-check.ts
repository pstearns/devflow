// Imported FIRST by the server and the auth CLI: ES imports run in order, so this refuses an old Node before
// node:sqlite / crypto.argon2 are touched (which would otherwise fail with a confusing error, or not at all).
export const MIN_NODE = [24, 7] as const;

export function nodeVersionError(version: string = process.versions.node): string | undefined {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) return undefined;
  return `Node ${MIN_NODE.join('.')} or newer is required (this is ${version}). Install a newer Node, or set NODE_BIN for the launcher.`;
}

const bad = nodeVersionError();
if (bad) { console.error(`DevFlow: ${bad}`); process.exit(1); }
