/**
 * Programmatic SDK for the `skills` CLI.
 *
 * Provides type-safe, non-interactive access to all skill management operations.
 * No interactive prompts, no process.exit(), no console output.
 */

import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { rm, lstat, readdir } from 'fs/promises';
import { basename, join, sep } from 'path';
import { homedir } from 'os';

import { parseSource, getOwnerRepo, parseOwnerRepo } from './source-parser.ts';
import { cloneRepo, cleanupTempDir } from './git.ts';
import { discoverSkills, filterSkills, getSkillDisplayName, parseSkillMd } from './skills.ts';
import {
  installSkillForAgent,
  installWellKnownSkillForAgent,
  isSkillInstalled,
  getCanonicalPath,
  getInstallPath,
  getCanonicalSkillsDir,
  sanitizeName,
  listInstalledSkills,
} from './installer.ts';
import type { InstallMode, InstallResult, InstalledSkill } from './installer.ts';
import {
  detectInstalledAgents,
  agents,
  getAgentConfig,
  getUniversalAgents,
  getNonUniversalAgents,
} from './agents.ts';
import { wellKnownProvider, type WellKnownSkill } from './providers/index.ts';
import {
  readSkillLock,
  addSkillToLock,
  removeSkillFromLock,
  getSkillFromLock,
  getAllLockedSkills,
  fetchSkillFolderHash,
  getGitHubToken,
  getSkillLockPath,
} from './skill-lock.ts';
import {
  readLocalLock,
  addSkillToLocalLock,
  removeSkillFromLocalLock,
  computeSkillFolderHash,
  getLocalLockPath,
} from './local-lock.ts';
import { searchSkillsAPI } from './find.ts';
import type { SearchSkill } from './find.ts';
import { buildUpdateInstallSource, formatSourceInput } from './update-source.ts';
import { discoverNodeModuleSkills } from './sync.ts';
import type { SyncOptions } from './sync.ts';
import type { Skill, AgentType, AgentConfig, ParsedSource, RemoteSkill } from './types.ts';
import type { SkillLockEntry, SkillLockFile } from './skill-lock.ts';
import type { LocalSkillLockEntry, LocalSkillLockFile } from './local-lock.ts';

// ─── Re-exports ───

export type { Skill, AgentType, AgentConfig, ParsedSource, RemoteSkill } from './types.ts';
export type { InstallMode, InstallResult, InstalledSkill } from './installer.ts';
export type { SkillLockEntry, SkillLockFile } from './skill-lock.ts';
export type { LocalSkillLockEntry, LocalSkillLockFile } from './local-lock.ts';
export type { SearchSkill } from './find.ts';
export type { WellKnownSkill } from './providers/index.ts';
export type { SyncOptions } from './sync.ts';

export { agents, getAgentConfig, getUniversalAgents, getNonUniversalAgents } from './agents.ts';
export { parseSource, getOwnerRepo } from './source-parser.ts';
export {
  sanitizeName,
  getCanonicalPath,
  getInstallPath,
  getCanonicalSkillsDir,
} from './installer.ts';
export { discoverSkills, filterSkills, parseSkillMd } from './skills.ts';
export {
  readSkillLock,
  getAllLockedSkills,
  getGitHubToken,
  getSkillLockPath,
} from './skill-lock.ts';
export { readLocalLock, getLocalLockPath } from './local-lock.ts';

// ─── SDK Result Types ───

export type SdkErrorCode =
  | 'SOURCE_PARSE_ERROR'
  | 'CLONE_ERROR'
  | 'NO_SKILLS_FOUND'
  | 'INVALID_AGENT'
  | 'INSTALL_FAILED'
  | 'NOT_FOUND'
  | 'UNKNOWN';

export interface SdkSuccess<T> {
  ok: true;
  data: T;
}

export interface SdkError {
  ok: false;
  error: string;
  code: SdkErrorCode;
}

export type SdkResult<T> = SdkSuccess<T> | SdkError;

function success<T>(data: T): SdkResult<T> {
  return { ok: true, data };
}

function failure(error: string, code: SdkErrorCode): SdkResult<never> {
  return { ok: false, error, code };
}

// ─── Add ───

export interface SdkAddOptions {
  /** Target agents to install to. Required. */
  agents: AgentType[];
  /** Global (user-level) vs project-level install. Default: false. */
  global?: boolean;
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /** Filter to specific skill names. undefined = all discovered skills. */
  skills?: string[];
  /** Installation mode. Default: 'symlink'. */
  mode?: InstallMode;
  /** Search all subdirectories even when a root SKILL.md exists. */
  fullDepth?: boolean;
}

export interface SdkAddInstallEntry {
  skillName: string;
  agent: AgentType;
  path: string;
  canonicalPath?: string;
  mode: InstallMode;
  symlinkFailed?: boolean;
}

export interface SdkAddFailEntry {
  skillName: string;
  agent: AgentType;
  error: string;
}

export interface SdkAddResultData {
  installed: SdkAddInstallEntry[];
  failed: SdkAddFailEntry[];
  discoveredSkills: Skill[];
  parsedSource: ParsedSource;
}

function validateAgents(agentList: AgentType[]): string | null {
  const valid = Object.keys(agents);
  const invalid = agentList.filter((a) => !valid.includes(a));
  if (invalid.length > 0) {
    return `Invalid agent(s): ${invalid.join(', ')}. Valid agents: ${valid.join(', ')}`;
  }
  return null;
}

export async function add(
  source: string,
  options: SdkAddOptions
): Promise<SdkResult<SdkAddResultData>> {
  const agentError = validateAgents(options.agents);
  if (agentError) return failure(agentError, 'INVALID_AGENT');

  const installGlobally = options.global ?? false;
  const cwd = options.cwd ?? process.cwd();
  const installMode = options.mode ?? 'symlink';

  let parsed: ParsedSource;
  try {
    parsed = parseSource(source);
  } catch (err) {
    return failure(
      err instanceof Error ? err.message : 'Failed to parse source',
      'SOURCE_PARSE_ERROR'
    );
  }

  // ── Well-known endpoint ──
  if (parsed.type === 'well-known') {
    return addFromWellKnown(parsed, options, installGlobally, cwd, installMode);
  }

  // ── Local or remote repo ──
  let tempDir: string | null = null;
  let skillsDir: string;

  try {
    if (parsed.type === 'local') {
      if (!existsSync(parsed.localPath!)) {
        return failure(`Local path does not exist: ${parsed.localPath}`, 'NOT_FOUND');
      }
      skillsDir = parsed.localPath!;
    } else {
      try {
        tempDir = await cloneRepo(parsed.url, parsed.ref);
      } catch (err) {
        return failure(
          err instanceof Error ? err.message : 'Failed to clone repository',
          'CLONE_ERROR'
        );
      }
      skillsDir = tempDir;
    }

    // Merge @skill syntax filter
    const skillFilter = options.skills ? [...options.skills] : undefined;
    if (parsed.skillFilter) {
      const sf = skillFilter ?? [];
      if (!sf.includes(parsed.skillFilter)) {
        sf.push(parsed.skillFilter);
      }
      if (!skillFilter) {
        // Only set filter if we actually added something
      }
      // Use sf as the effective filter
      return addFromDir(
        parsed,
        skillsDir,
        tempDir,
        { ...options, skills: sf },
        installGlobally,
        cwd,
        installMode
      );
    }

    return addFromDir(parsed, skillsDir, tempDir, options, installGlobally, cwd, installMode);
  } catch (err) {
    if (tempDir) await cleanupTempDir(tempDir).catch(() => {});
    return failure(err instanceof Error ? err.message : 'Unknown error', 'UNKNOWN');
  }
}

async function addFromWellKnown(
  parsed: ParsedSource,
  options: SdkAddOptions,
  installGlobally: boolean,
  cwd: string,
  installMode: InstallMode
): Promise<SdkResult<SdkAddResultData>> {
  let allSkills: WellKnownSkill[];
  try {
    allSkills = await wellKnownProvider.fetchAllSkills(parsed.url);
  } catch (err) {
    return failure(
      err instanceof Error ? err.message : 'Failed to fetch well-known skills',
      'CLONE_ERROR'
    );
  }

  if (allSkills.length === 0) {
    return failure('No skills found at well-known endpoint', 'NO_SKILLS_FOUND');
  }

  // Filter by skill names if requested
  let selectedSkills = allSkills;
  if (options.skills && options.skills.length > 0) {
    selectedSkills = allSkills.filter((s) =>
      options.skills!.some(
        (name) =>
          s.installName.toLowerCase() === name.toLowerCase() ||
          s.name.toLowerCase() === name.toLowerCase()
      )
    );
    if (selectedSkills.length === 0) {
      return failure(
        `No matching skills for: ${options.skills.join(', ')}. Available: ${allSkills.map((s) => s.installName).join(', ')}`,
        'NO_SKILLS_FOUND'
      );
    }
  }

  const installed: SdkAddInstallEntry[] = [];
  const failed: SdkAddFailEntry[] = [];

  for (const skill of selectedSkills) {
    for (const agent of options.agents) {
      const result = await installWellKnownSkillForAgent(skill, agent, {
        global: installGlobally,
        mode: installMode,
      });
      if (result.success) {
        installed.push({
          skillName: skill.installName,
          agent,
          path: result.path,
          canonicalPath: result.canonicalPath,
          mode: result.mode,
          symlinkFailed: result.symlinkFailed,
        });
      } else {
        failed.push({
          skillName: skill.installName,
          agent,
          error: result.error ?? 'Unknown error',
        });
      }
    }
  }

  // Update lock files
  const sourceIdentifier = wellKnownProvider.getSourceIdentifier(parsed.url);
  await updateLockFilesForWellKnown(
    selectedSkills,
    installed,
    sourceIdentifier,
    installGlobally,
    cwd
  );

  // Map WellKnownSkill to Skill for discoveredSkills
  const discoveredSkills: Skill[] = allSkills.map((s) => ({
    name: s.installName,
    description: s.description,
    path: '',
  }));

  return success({ installed, failed, discoveredSkills, parsedSource: parsed });
}

async function updateLockFilesForWellKnown(
  skills: WellKnownSkill[],
  installed: SdkAddInstallEntry[],
  sourceIdentifier: string,
  installGlobally: boolean,
  cwd: string
): Promise<void> {
  const successfulNames = new Set(installed.map((r) => r.skillName));

  for (const skill of skills) {
    if (!successfulNames.has(skill.installName)) continue;

    try {
      if (installGlobally) {
        await addSkillToLock(skill.installName, {
          source: sourceIdentifier,
          sourceType: 'well-known',
          sourceUrl: skill.sourceUrl,
          skillFolderHash: '',
        });
      } else {
        const matchingResult = installed.find((r) => r.skillName === skill.installName);
        const installDir = matchingResult?.canonicalPath || matchingResult?.path;
        if (installDir) {
          const computedHash = await computeSkillFolderHash(installDir);
          await addSkillToLocalLock(
            skill.installName,
            {
              source: sourceIdentifier,
              sourceType: 'well-known',
              computedHash,
            },
            cwd
          );
        }
      }
    } catch {
      // Don't fail the operation if lock file update fails
    }
  }
}

async function addFromDir(
  parsed: ParsedSource,
  skillsDir: string,
  tempDir: string | null,
  options: SdkAddOptions,
  installGlobally: boolean,
  cwd: string,
  installMode: InstallMode
): Promise<SdkResult<SdkAddResultData>> {
  try {
    const includeInternal = !!(options.skills && options.skills.length > 0);

    const skills = await discoverSkills(skillsDir, parsed.subpath, {
      includeInternal,
      fullDepth: options.fullDepth,
    });

    if (skills.length === 0) {
      return failure(
        'No valid skills found. Skills require a SKILL.md with name and description.',
        'NO_SKILLS_FOUND'
      );
    }

    // Filter skills if requested
    let selectedSkills = skills;
    if (options.skills && options.skills.length > 0) {
      selectedSkills = filterSkills(skills, options.skills);
      if (selectedSkills.length === 0) {
        return failure(
          `No matching skills for: ${options.skills.join(', ')}. Available: ${skills.map((s) => getSkillDisplayName(s)).join(', ')}`,
          'NO_SKILLS_FOUND'
        );
      }
    }

    // Install each skill to each agent
    const installed: SdkAddInstallEntry[] = [];
    const failed: SdkAddFailEntry[] = [];

    for (const skill of selectedSkills) {
      for (const agent of options.agents) {
        const result = await installSkillForAgent(skill, agent, {
          global: installGlobally,
          cwd,
          mode: installMode,
        });
        const displayName = getSkillDisplayName(skill);
        if (result.success) {
          installed.push({
            skillName: displayName,
            agent,
            path: result.path,
            canonicalPath: result.canonicalPath,
            mode: result.mode,
            symlinkFailed: result.symlinkFailed,
          });
        } else {
          failed.push({
            skillName: displayName,
            agent,
            error: result.error ?? 'Unknown error',
          });
        }
      }
    }

    // Update lock files
    await updateLockFilesForRepo(parsed, selectedSkills, installed, tempDir, installGlobally, cwd);

    return success({ installed, failed, discoveredSkills: skills, parsedSource: parsed });
  } finally {
    if (tempDir) await cleanupTempDir(tempDir).catch(() => {});
  }
}

async function updateLockFilesForRepo(
  parsed: ParsedSource,
  skills: Skill[],
  installed: SdkAddInstallEntry[],
  tempDir: string | null,
  installGlobally: boolean,
  cwd: string
): Promise<void> {
  const normalizedSource = getOwnerRepo(parsed);
  const isSSH = parsed.url.startsWith('git@');
  const lockSource = isSSH ? parsed.url : normalizedSource;
  const successfulNames = new Set(installed.map((r) => r.skillName));

  // Build skillFiles map: relative paths for each skill
  const skillFiles: Record<string, string> = {};
  for (const skill of skills) {
    const displayName = getSkillDisplayName(skill);
    if (!successfulNames.has(displayName)) continue;

    if (tempDir && skill.path === tempDir) {
      skillFiles[skill.name] = 'SKILL.md';
    } else if (tempDir && skill.path.startsWith(tempDir + sep)) {
      skillFiles[skill.name] =
        skill.path
          .slice(tempDir.length + 1)
          .split(sep)
          .join('/') + '/SKILL.md';
    }
  }

  // Global lock
  if (installed.length > 0 && installGlobally && normalizedSource) {
    for (const skill of skills) {
      const displayName = getSkillDisplayName(skill);
      if (!successfulNames.has(displayName)) continue;

      try {
        let skillFolderHash = '';
        const skillPathValue = skillFiles[skill.name];
        if (parsed.type === 'github' && skillPathValue) {
          const token = getGitHubToken();
          const hash = await fetchSkillFolderHash(
            normalizedSource,
            skillPathValue,
            token,
            parsed.ref
          );
          if (hash) skillFolderHash = hash;
        }

        await addSkillToLock(skill.name, {
          source: lockSource || normalizedSource,
          sourceType: parsed.type,
          sourceUrl: parsed.url,
          ref: parsed.ref,
          skillPath: skillPathValue,
          skillFolderHash,
          pluginName: skill.pluginName,
        });
      } catch {
        // Don't fail if lock update fails
      }
    }
  }

  // Local lock
  if (installed.length > 0 && !installGlobally) {
    for (const skill of skills) {
      const displayName = getSkillDisplayName(skill);
      if (!successfulNames.has(displayName)) continue;

      try {
        const computedHash = await computeSkillFolderHash(skill.path);
        await addSkillToLocalLock(
          skill.name,
          {
            source: lockSource || parsed.url,
            ref: parsed.ref,
            sourceType: parsed.type,
            computedHash,
          },
          cwd
        );
      } catch {
        // Don't fail if lock update fails
      }
    }
  }
}

// ─── Remove ───

export interface SdkRemoveOptions {
  /** Skill names to remove. Required. */
  skills: string[];
  /** Global or project scope. Default: false. */
  global?: boolean;
  /** Target specific agents. Default: all known agents. */
  agents?: AgentType[];
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
}

export interface SdkRemoveResultData {
  removed: Array<{ skill: string; source?: string; sourceType?: string }>;
  failed: Array<{ skill: string; error: string }>;
}

export async function remove(options: SdkRemoveOptions): Promise<SdkResult<SdkRemoveResultData>> {
  if (options.agents) {
    const agentError = validateAgents(options.agents);
    if (agentError) return failure(agentError, 'INVALID_AGENT');
  }

  const isGlobal = options.global ?? false;
  const cwd = options.cwd ?? process.cwd();
  const targetAgents: AgentType[] = options.agents ?? (Object.keys(agents) as AgentType[]);

  const removed: SdkRemoveResultData['removed'] = [];
  const failed: SdkRemoveResultData['failed'] = [];

  for (const skillName of options.skills) {
    try {
      const canonicalPath = getCanonicalPath(skillName, { global: isGlobal, cwd });

      // Remove from each agent's directory
      for (const agentKey of targetAgents) {
        const agent = agents[agentKey];
        const skillPath = getInstallPath(skillName, agentKey, { global: isGlobal, cwd });

        const pathsToCleanup = new Set([skillPath]);
        const sanitizedName = sanitizeName(skillName);
        if (isGlobal && agent.globalSkillsDir) {
          pathsToCleanup.add(join(agent.globalSkillsDir, sanitizedName));
        } else {
          pathsToCleanup.add(join(cwd, agent.skillsDir, sanitizedName));
        }

        for (const pathToCleanup of pathsToCleanup) {
          if (pathToCleanup === canonicalPath) continue;
          try {
            const stats = await lstat(pathToCleanup).catch(() => null);
            if (stats) {
              await rm(pathToCleanup, { recursive: true, force: true });
            }
          } catch {
            // Continue cleanup
          }
        }
      }

      // Check if canonical path is still used by other agents
      const allDetected = await detectInstalledAgents();
      const remainingAgents = allDetected.filter((a) => !targetAgents.includes(a));

      let isStillUsed = false;
      for (const agentKey of remainingAgents) {
        const path = getInstallPath(skillName, agentKey, { global: isGlobal, cwd });
        const exists = await lstat(path).catch(() => null);
        if (exists) {
          isStillUsed = true;
          break;
        }
      }

      if (!isStillUsed) {
        await rm(canonicalPath, { recursive: true, force: true });
      }

      // Get lock info before removing
      const lockEntry = isGlobal ? await getSkillFromLock(skillName) : null;

      if (isGlobal) {
        await removeSkillFromLock(skillName);
      }

      if (!isGlobal) {
        await removeSkillFromLocalLock(skillName, cwd);
      }

      removed.push({
        skill: skillName,
        source: lockEntry?.source,
        sourceType: lockEntry?.sourceType,
      });
    } catch (err) {
      failed.push({
        skill: skillName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return success({ removed, failed });
}

// ─── List ───

export interface SdkListOptions {
  /** List global or project skills. undefined = both. */
  global?: boolean;
  /** Working directory. */
  cwd?: string;
  /** Filter by specific agents. */
  agentFilter?: AgentType[];
}

export async function list(options?: SdkListOptions): Promise<SdkResult<InstalledSkill[]>> {
  try {
    const result = await listInstalledSkills({
      global: options?.global,
      cwd: options?.cwd,
      agentFilter: options?.agentFilter,
    });
    return success(result);
  } catch (err) {
    return failure(err instanceof Error ? err.message : 'Failed to list skills', 'UNKNOWN');
  }
}

// ─── Find ───

export async function find(query: string): Promise<SdkResult<SearchSkill[]>> {
  try {
    const results = await searchSkillsAPI(query);
    return success(results);
  } catch (err) {
    return failure(err instanceof Error ? err.message : 'Search failed', 'UNKNOWN');
  }
}

// ─── Check ───

export interface SdkCheckOptions {
  /** GitHub token for higher rate limits. Auto-detected if omitted. */
  token?: string | null;
}

export interface SkillUpdateInfo {
  name: string;
  source: string;
  currentHash: string;
  latestHash: string;
}

export interface SkillSkipped {
  name: string;
  reason: string;
  sourceUrl: string;
  ref?: string;
}

export interface SdkCheckResultData {
  updates: SkillUpdateInfo[];
  upToDate: string[];
  skipped: SkillSkipped[];
  errors: Array<{ name: string; source: string; error: string }>;
}

function getSkipReason(entry: SkillLockEntry): string {
  if (entry.sourceType === 'local') return 'Local path';
  if (entry.sourceType === 'git') return 'Git URL (hash tracking not supported)';
  if (!entry.skillFolderHash) return 'No version hash available';
  if (!entry.skillPath) return 'No skill path recorded';
  return 'No version tracking';
}

export async function check(options?: SdkCheckOptions): Promise<SdkResult<SdkCheckResultData>> {
  try {
    const lock = await readSkillLock();
    const skillNames = Object.keys(lock.skills);

    if (skillNames.length === 0) {
      return success({ updates: [], upToDate: [], skipped: [], errors: [] });
    }

    const token = options?.token !== undefined ? options.token : getGitHubToken();
    const updates: SkillUpdateInfo[] = [];
    const upToDate: string[] = [];
    const skipped: SkillSkipped[] = [];
    const errors: SdkCheckResultData['errors'] = [];

    for (const skillName of skillNames) {
      const entry = lock.skills[skillName];
      if (!entry) continue;

      if (!entry.skillFolderHash || !entry.skillPath) {
        skipped.push({
          name: skillName,
          reason: getSkipReason(entry),
          sourceUrl: entry.sourceUrl,
          ref: entry.ref,
        });
        continue;
      }

      try {
        const latestHash = await fetchSkillFolderHash(
          entry.source,
          entry.skillPath,
          token,
          entry.ref
        );

        if (!latestHash) {
          errors.push({
            name: skillName,
            source: entry.source,
            error: 'Could not fetch from GitHub',
          });
          continue;
        }

        if (latestHash !== entry.skillFolderHash) {
          updates.push({
            name: skillName,
            source: entry.source,
            currentHash: entry.skillFolderHash,
            latestHash,
          });
        } else {
          upToDate.push(skillName);
        }
      } catch (err) {
        errors.push({
          name: skillName,
          source: entry.source,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return success({ updates, upToDate, skipped, errors });
  } catch (err) {
    return failure(err instanceof Error ? err.message : 'Check failed', 'UNKNOWN');
  }
}

// ─── Update ───

export interface SdkUpdateOptions {
  /** Agents to install updates to. Required. */
  agents: AgentType[];
  /** GitHub token for higher rate limits. Auto-detected if omitted. */
  token?: string | null;
  /** Working directory. */
  cwd?: string;
}

export interface SdkUpdateResultData {
  updated: Array<{ name: string; source: string }>;
  failed: Array<{ name: string; source: string; error: string }>;
  skipped: SkillSkipped[];
}

export async function update(options: SdkUpdateOptions): Promise<SdkResult<SdkUpdateResultData>> {
  const agentError = validateAgents(options.agents);
  if (agentError) return failure(agentError, 'INVALID_AGENT');

  try {
    // First, check what needs updating
    const checkResult = await check({ token: options.token });
    if (!checkResult.ok) return checkResult;

    const { updates: availableUpdates, skipped } = checkResult.data;

    if (availableUpdates.length === 0) {
      return success({ updated: [], failed: [], skipped });
    }

    // Read lock to get full entries for building install sources
    const lock = await readSkillLock();
    const updated: SdkUpdateResultData['updated'] = [];
    const failed: SdkUpdateResultData['failed'] = [];

    for (const updateInfo of availableUpdates) {
      const entry = lock.skills[updateInfo.name];
      if (!entry) {
        failed.push({
          name: updateInfo.name,
          source: updateInfo.source,
          error: 'Lock entry not found',
        });
        continue;
      }

      const installSource = buildUpdateInstallSource(entry);

      const addResult = await add(installSource, {
        agents: options.agents,
        global: true,
        cwd: options.cwd,
      });

      if (addResult.ok && addResult.data.installed.length > 0) {
        updated.push({ name: updateInfo.name, source: updateInfo.source });
      } else {
        const errorMsg = addResult.ok ? 'No skills were installed' : addResult.error;
        failed.push({ name: updateInfo.name, source: updateInfo.source, error: errorMsg });
      }
    }

    return success({ updated, failed, skipped });
  } catch (err) {
    return failure(err instanceof Error ? err.message : 'Update failed', 'UNKNOWN');
  }
}

// ─── Detect Agents ───

export { detectInstalledAgents as detectAgents } from './agents.ts';

// ─── Init ───

export interface SdkInitOptions {
  /** Skill name. Defaults to basename of cwd. */
  name?: string;
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
}

export interface SdkInitResultData {
  path: string;
  content: string;
  alreadyExists: boolean;
}

export function init(options?: SdkInitOptions): SdkResult<SdkInitResultData> {
  try {
    const cwd = options?.cwd ?? process.cwd();
    const skillName = options?.name || basename(cwd);
    const hasName = !!options?.name;

    const skillDir = hasName ? join(cwd, skillName) : cwd;
    const skillFile = join(skillDir, 'SKILL.md');

    if (existsSync(skillFile)) {
      return success({ path: skillFile, content: '', alreadyExists: true });
    }

    if (hasName) {
      mkdirSync(skillDir, { recursive: true });
    }

    const content = `---
name: ${skillName}
description: A brief description of what this skill does
---

# ${skillName}

Instructions for the agent to follow when this skill is activated.

## When to use

Describe when this skill should be used.

## Instructions

1. First step
2. Second step
3. Additional steps as needed
`;

    writeFileSync(skillFile, content);

    return success({ path: skillFile, content, alreadyExists: false });
  } catch (err) {
    return failure(err instanceof Error ? err.message : 'Init failed', 'UNKNOWN');
  }
}

// ─── Sync ───

export interface SdkSyncOptions {
  /** Target agents. Required. */
  agents: AgentType[];
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /** Force reinstall even if hash matches. */
  force?: boolean;
}

export interface SdkSyncResultData {
  installed: Array<{ skillName: string; packageName: string; agent: AgentType; path: string }>;
  failed: Array<{ skillName: string; packageName: string; agent: AgentType; error: string }>;
  upToDate: string[];
}

export async function sync(options: SdkSyncOptions): Promise<SdkResult<SdkSyncResultData>> {
  const agentError = validateAgents(options.agents);
  if (agentError) return failure(agentError, 'INVALID_AGENT');

  try {
    const cwd = options.cwd ?? process.cwd();
    const skills = await discoverNodeModuleSkills(cwd);

    if (skills.length === 0) {
      return success({ installed: [], failed: [], upToDate: [] });
    }

    // Read local lock to check for changes
    const localLock = await readLocalLock(cwd);
    const installed: SdkSyncResultData['installed'] = [];
    const failed: SdkSyncResultData['failed'] = [];
    const upToDate: string[] = [];

    for (const skill of skills) {
      // Check if already up-to-date (unless force)
      if (!options.force) {
        const existingEntry = localLock.skills[skill.name];
        if (existingEntry) {
          try {
            const currentHash = await computeSkillFolderHash(skill.path);
            if (currentHash === existingEntry.computedHash) {
              upToDate.push(skill.name);
              continue;
            }
          } catch {
            // If hash check fails, install anyway
          }
        }
      }

      for (const agent of options.agents) {
        const result = await installSkillForAgent(skill, agent, {
          global: false,
          cwd,
          mode: 'symlink',
        });

        if (result.success) {
          installed.push({
            skillName: skill.name,
            packageName: skill.packageName,
            agent,
            path: result.path,
          });
        } else {
          failed.push({
            skillName: skill.name,
            packageName: skill.packageName,
            agent,
            error: result.error ?? 'Unknown error',
          });
        }
      }

      // Update local lock
      try {
        const computedHash = await computeSkillFolderHash(skill.path);
        await addSkillToLocalLock(
          skill.name,
          {
            source: `npm:${skill.packageName}`,
            sourceType: 'npm',
            computedHash,
          },
          cwd
        );
      } catch {
        // Don't fail if lock update fails
      }
    }

    return success({ installed, failed, upToDate });
  } catch (err) {
    return failure(err instanceof Error ? err.message : 'Sync failed', 'UNKNOWN');
  }
}

// ─── Install From Lock ───

export interface SdkInstallFromLockOptions {
  /** Agents to install to. If omitted, auto-detects installed agents. */
  agents?: AgentType[];
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
}

export interface SdkInstallFromLockResultData {
  results: Array<{
    source: string;
    addResult: SdkResult<SdkAddResultData>;
  }>;
}

export async function installFromLock(
  options?: SdkInstallFromLockOptions
): Promise<SdkResult<SdkInstallFromLockResultData>> {
  try {
    const cwd = options?.cwd ?? process.cwd();
    const targetAgents = options?.agents ?? (await detectInstalledAgents());

    if (targetAgents.length > 0) {
      const agentError = validateAgents(targetAgents);
      if (agentError) return failure(agentError, 'INVALID_AGENT');
    }

    const localLock = await readLocalLock(cwd);
    const skillEntries = Object.entries(localLock.skills);

    if (skillEntries.length === 0) {
      return success({ results: [] });
    }

    // Group skills by source
    const bySource = new Map<string, string[]>();
    for (const [name, entry] of skillEntries) {
      if (entry.sourceType === 'npm') continue; // npm skills handled via sync
      const source = entry.source;
      const existing = bySource.get(source) ?? [];
      existing.push(name);
      bySource.set(source, existing);
    }

    const results: SdkInstallFromLockResultData['results'] = [];

    for (const [source, skillNames] of bySource) {
      const addResult = await add(source, {
        agents: targetAgents,
        global: false,
        cwd,
        skills: skillNames,
      });
      results.push({ source, addResult });
    }

    return success({ results });
  } catch (err) {
    return failure(err instanceof Error ? err.message : 'Install from lock failed', 'UNKNOWN');
  }
}
