// The single source of truth for "which rules apply to this issue" and "may DevFlow write to it".
// Inputs are ALWAYS facts read from Linear (the issue's own team and project). The browser's selected team/project is a
// display filter only and never reaches this module. Nothing is inherited across teams, or from a project to
// issues that are not in that project.
import type { PolicySource } from '../shared/types.ts';
import { DEFAULT_WORKFLOW, type Config, type ProjectCfg, type TeamCfg, type WorkflowCfg } from './config.ts';

export interface LinearProjectRef { id: string; name: string; slugId?: string }

export interface Scope {
  teamKey: string;
  project?: LinearProjectRef;
  configProject?: ProjectCfg;
  teamCfg?: TeamCfg;
  workflow: WorkflowCfg;
  policy: PolicySource; // 'project' = a config project's workflow; 'team' = explicit team workflow; 'default' = generic defaults (display only)
  /** True only when a policy was written down for exactly this scope. Approval for execution requires it. */
  explicitPolicy: boolean;
  writeAllowed: boolean;
  writeReason?: string;
  repos: string[]; // only repositories configured for this scope
}

const low = (s: string) => s.toLowerCase();
const matches = (wanted: string[], p: LinearProjectRef) => wanted.some((w) => [p.id, p.name, p.slugId].some((v) => v && low(v) === low(w)));

export function resolveScope(cfg: Config, teamKeyRaw: string, project?: LinearProjectRef): Scope {
  const teamKey = teamKeyRaw.toUpperCase();
  const teamCfg = cfg.teams.find((t) => t.key === teamKey);
  const inTeam = cfg.projects.filter((p) => p.linear?.teamKey === teamKey);
  // A config project covers a Linear project when it names it, or when it covers the whole team (empty list).
  // Unprojected issues are NEVER covered by a project entry, even a whole-team one.
  const specific = project ? inTeam.find((p) => p.linear!.projects.length > 0 && matches(p.linear!.projects, project)) : undefined;
  const whole = project ? inTeam.find((p) => p.linear!.projects.length === 0) : undefined;
  const configProject = specific ?? whole;
  if (configProject) {
    return { teamKey, project, configProject, teamCfg, workflow: configProject.workflow, policy: 'project', explicitPolicy: true, writeAllowed: true, repos: configProject.repos };
  }
  const where = project ? `Project "${project.name}" in team ${teamKey} is` : `Unprojected issues in team ${teamKey} are`;
  if (teamCfg) {
    return {
      teamKey, project, teamCfg, workflow: teamCfg.workflow ?? DEFAULT_WORKFLOW, policy: teamCfg.workflow ? 'team' : 'default', explicitPolicy: !!teamCfg.workflow,
      writeAllowed: teamCfg.write, writeReason: teamCfg.write ? undefined : `Writes are not enabled for team ${teamKey} (set write: true in its teams[] entry)`, repos: teamCfg.repos,
    };
  }
  return {
    teamKey, project, workflow: DEFAULT_WORKFLOW, policy: 'default', explicitPolicy: false, writeAllowed: false, repos: [],
    writeReason: `${where} not covered by any configured project or teams[] entry, so DevFlow treats ${project ? 'it' : 'them'} as read-only`,
  };
}

/** Teams that appear in config at all: loaded at dashboard open; all others are read when first selected. */
export function configuredTeamKeys(cfg: Config): string[] {
  return [...new Set([...cfg.projects.map((p) => p.linear?.teamKey).filter((k): k is string => !!k), ...cfg.teams.map((t) => t.key)])];
}

/** Every repo DevFlow may read, with the scope(s) that own it. A repo is owned by the first entry that lists it. */
export function repoOwners(cfg: Config): Map<string, { teamKey: string; projects: ProjectCfg | undefined; team: TeamCfg | undefined }> {
  const m = new Map<string, { teamKey: string; projects: ProjectCfg | undefined; team: TeamCfg | undefined }>();
  for (const p of cfg.projects) for (const r of p.repos) if (!m.has(r)) m.set(r, { teamKey: p.linear?.teamKey ?? '', projects: p, team: undefined });
  for (const t of cfg.teams) for (const r of t.repos) if (!m.has(r)) m.set(r, { teamKey: t.key, projects: undefined, team: t });
  return m;
}
