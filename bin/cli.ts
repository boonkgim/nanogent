#!/usr/bin/env node
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  readSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const here = dirname(fileURLToPath(import.meta.url));
const tplDir = join(here, '..', 'template');

const usage = `
nanogent — per-project chat agent with pluggable tools, channels, and providers

  nanogent init                       drop core files into .nanogent/ and install the default profile's plugins
  nanogent init --profile <path>      use a custom profile file (defaults to the shipped 'default' profile)
  nanogent build                      regenerate .nanogent/Dockerfile.generated from the base Dockerfile + plugin install.sh files
  nanogent start                      run the listener in docker (docker compose up --build)
  nanogent update                     update runtime code; preserves prompt / config / contacts / local plugin edits
  nanogent update --force             also overwrite locally-modified plugin files
  nanogent update --dry-run           show what update would do, without changing files
  nanogent plugin list                list installed plugins under .nanogent/
  nanogent plugin add <ref>           install a plugin from a local path (plugin.json required at the target)
  nanogent plugin add <ref> --force   overwrite an existing plugin dir
  nanogent plugin remove <name>       remove a plugin dir after confirmation (matched by plugin name)
  nanogent plugin remove <name> -f    remove without confirmation
  nanogent uninstall                  delete .nanogent/ after confirmation
  nanogent uninstall -f               delete .nanogent/ without confirmation

after init:
  1. cp .nanogent/.env.example .nanogent/.env
  2. fill TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY in .env
  3. edit .nanogent/contacts.json — replace the REPLACE_WITH_YOUR_TELEGRAM_* placeholders
  4. edit .nanogent/prompt.md for this project / client
  5. nanogent start

in-chat (once running):
  any text    → routed through the chat agent, which may delegate to tools
  /status     current background job
  /cancel     cancel running job
  /clear      wipe chat history for the current chat
  /help       show command list

docker is required — nanogent always runs the listener inside a container so
plugin dependencies stay isolated from the host project.

to stop:    Ctrl+C   (or: cd .nanogent && docker compose down)
to update:  nanogent update
to remove:  nanogent uninstall   (or: rm -rf .nanogent)
`;

type EntryType = 'code' | 'plugin' | 'config';

export interface ManifestEntry {
  src: string;
  dest: string;
  type: EntryType;
}

/**
 * Core manifest. These files are dropped by `nanogent init` unconditionally
 * and form the non-pluggable substrate: the runtime, the Docker harness,
 * and the operator-owned config seeds. Nothing in here names any specific
 * plugin — that's the whole point of the core/plugin split introduced in
 * v0.10.0 (see DR-013).
 *
 * The type tag drives `nanogent update` phase 1:
 *
 *   code   — always overwritten on update. No one should be customising these.
 *   config — never touched by update; only created if missing. Operator-owned.
 *
 * The third type ('plugin') is reserved for phase 2 of update, which walks
 * the installed plugin tree dynamically rather than reading a static list.
 */
export const CORE_MANIFEST: ManifestEntry[] = [
  // Core runtime (always updatable)
  { src: 'nanogent.ts',        dest: '.nanogent/nanogent.ts',        type: 'code' },
  { src: 'types.d.ts',         dest: '.nanogent/types.d.ts',         type: 'code' },
  { src: 'Dockerfile',         dest: '.nanogent/Dockerfile',         type: 'code' },
  { src: 'docker-compose.yml', dest: '.nanogent/docker-compose.yml', type: 'code' },
  { src: '.env.example',       dest: '.nanogent/.env.example',       type: 'code' },

  // User config (never touched by update; only created on init)
  { src: 'prompt.md',          dest: '.nanogent/prompt.md',          type: 'config' },
  { src: 'config.json',        dest: '.nanogent/config.json',        type: 'config' },
  { src: 'contacts.json',      dest: '.nanogent/contacts.json',      type: 'config' },
  { src: 'gitignore',          dest: '.nanogent/.gitignore',         type: 'config' },  // npm strips .gitignore — ship as `gitignore`, rename on install
];

function copyFromManifest(manifest: ManifestEntry[]): void {
  for (const { src, dest } of manifest) {
    const from = join(tplDir, src);
    const to = join(process.cwd(), dest);
    if (existsSync(to)) {
      console.log(`skip (exists): ${dest}`);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    console.log(`created:       ${dest}`);
  }
}

// ---------------------------------------------------------------------------
// Plugin system (v0.10.0) — OCP-clean decoupling of core and plugins.
// ---------------------------------------------------------------------------
//
// A plugin is a self-describing directory containing a `plugin.json` manifest.
// Core knows nothing about any specific plugin name; install, update, build,
// and runtime discovery all walk directories instead of consulting hardcoded
// lists. The "defaults" shipped with this package are a profile file
// (template/profiles/default.json) that lists plugin refs — swapping a
// default means editing one JSON entry, not editing core code.
//
// v1 resolver supports local paths only (absolute, or relative to the
// profile file's directory). Git URLs, npm packages, and a lock file are
// deferred. See DR-013 in DESIGN.md.

/** Valid plugin type directories under .nanogent/. Each corresponds to one
 *  extension point the runtime discovers (see template/core/nanogent.ts).
 *  Single source of truth for all plugin-tree walks below. */
export const PLUGIN_TYPES = [
  'tools', 'channels', 'providers', 'history',
] as const;
export type PluginType = typeof PLUGIN_TYPES[number];

function isPluginType(x: unknown): x is PluginType {
  return typeof x === 'string' && (PLUGIN_TYPES as readonly string[]).includes(x);
}

/**
 * Contents of a plugin's `plugin.json`. Required on every installable plugin.
 *
 *   name        — directory name under .nanogent/<type>/; must be safe for a
 *                 filesystem path (no slashes, no '..').
 *   type        — one of PLUGIN_TYPES; decides where the plugin lands.
 *   description — optional human-readable blurb for `plugin list`.
 *   files       — optional explicit file list (relative to the plugin dir,
 *                 shallow only). When omitted, the installer copies every
 *                 regular file in the source dir. Hidden files (leading '.')
 *                 are skipped unless listed explicitly.
 *
 * Two filename conventions are applied on install:
 *   - A file literally named `gitignore` is copied as `.gitignore` (works
 *     around `npm pack` stripping `.gitignore` entries).
 *   - A file named `install.sh` is chmod'd to 0o755 after copy (`npm pack`
 *     also strips the executable bit).
 */
export interface PluginManifest {
  name: string;
  type: PluginType;
  description?: string;
  files?: string[];
}

export interface Profile {
  name: string;
  description?: string;
  plugins: { ref: string }[];
}

export interface ResolvedPlugin {
  /** Absolute path to the plugin's source directory. */
  sourceDir: string;
  manifest: PluginManifest;
  /** Files to copy (post-defaulting). Shallow, relative to sourceDir. */
  files: string[];
}

/** Read and validate a plugin's `plugin.json`. Throws with a helpful message
 *  if the file is missing, unparseable, or has invalid fields. */
export function readPluginManifest(sourceDir: string): PluginManifest {
  const manifestPath = join(sourceDir, 'plugin.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${sourceDir}: missing plugin.json — every installable plugin must ship one`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`${manifestPath}: invalid JSON (${(e as Error).message})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${manifestPath}: must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string' || obj.name.length === 0 || obj.name.includes('/') || obj.name.includes('..')) {
    throw new Error(`${manifestPath}: 'name' must be a non-empty string with no slashes or '..'`);
  }
  if (!isPluginType(obj.type)) {
    throw new Error(`${manifestPath}: 'type' must be one of ${PLUGIN_TYPES.join(', ')} (got ${JSON.stringify(obj.type)})`);
  }
  const manifest: PluginManifest = { name: obj.name, type: obj.type };
  if (typeof obj.description === 'string') manifest.description = obj.description;
  if (Array.isArray(obj.files)) {
    for (const f of obj.files) {
      if (typeof f !== 'string' || f.length === 0 || f.includes('..') || isAbsolute(f)) {
        throw new Error(`${manifestPath}: 'files' entries must be non-empty relative paths without '..' (got ${JSON.stringify(f)})`);
      }
    }
    manifest.files = obj.files as string[];
  }
  return manifest;
}

/** Default file list when `files` is omitted: every regular (non-hidden)
 *  file at the top level of the plugin dir, sorted for stable ordering. */
function defaultPluginFiles(sourceDir: string): string[] {
  return readdirSync(sourceDir, { withFileTypes: true })
    .filter(e => e.isFile() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort();
}

/**
 * Resolve a plugin ref to an absolute source directory with a validated
 * manifest. v1 only supports local paths — absolute, or relative to
 * `baseDir` (typically the profile file's directory for profile-driven
 * installs, or `process.cwd()` for `plugin add <path>`).
 */
export function resolvePlugin(ref: string, baseDir: string): ResolvedPlugin {
  const sourceDir = isAbsolute(ref) ? ref : pathResolve(baseDir, ref);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new Error(`plugin ref '${ref}' does not resolve to a directory (looked at ${sourceDir})`);
  }
  const manifest = readPluginManifest(sourceDir);
  const files = manifest.files ?? defaultPluginFiles(sourceDir);
  return { sourceDir, manifest, files };
}

/** Load and validate a profile file. Refs inside stay as strings — they are
 *  resolved at install time against the profile file's own directory. */
export function loadProfile(profilePath: string): Profile {
  if (!existsSync(profilePath)) {
    throw new Error(`profile file not found: ${profilePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(profilePath, 'utf8'));
  } catch (e) {
    throw new Error(`${profilePath}: invalid JSON (${(e as Error).message})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${profilePath}: must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== 'string') {
    throw new Error(`${profilePath}: 'name' must be a string`);
  }
  if (!Array.isArray(obj.plugins)) {
    throw new Error(`${profilePath}: 'plugins' must be an array`);
  }
  const plugins: { ref: string }[] = [];
  for (const entry of obj.plugins) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${profilePath}: each 'plugins' entry must be an object with a 'ref' field`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.ref !== 'string' || e.ref.length === 0) {
      throw new Error(`${profilePath}: each 'plugins' entry must have a non-empty 'ref' string`);
    }
    plugins.push({ ref: e.ref });
  }
  const profile: Profile = { name: obj.name, plugins };
  if (typeof obj.description === 'string') profile.description = obj.description;
  return profile;
}

export interface InstallPluginOptions {
  force?: boolean;
  logger?: (msg: string) => void;
}

export interface InstallPluginResult {
  targetDir: string;
  filesInstalled: string[];
}

/**
 * Install a resolved plugin into `.nanogent/<type>/<name>/`. Copies each file
 * in `resolved.files` (plus plugin.json if not already listed), applying the
 * gitignore→.gitignore rename and the install.sh chmod. Refuses to overwrite
 * an existing plugin dir unless `force` is set.
 */
export function installPlugin(
  resolved: ResolvedPlugin,
  nanogentDir: string,
  opts: InstallPluginOptions = {},
): InstallPluginResult {
  const log = opts.logger ?? ((msg: string) => { console.log(msg); });
  const targetDir = join(nanogentDir, resolved.manifest.type, resolved.manifest.name);

  if (existsSync(targetDir) && !opts.force) {
    throw new Error(
      `plugin already installed at ${targetDir} — pass force to overwrite, ` +
      'or `nanogent plugin remove` it first',
    );
  }
  mkdirSync(targetDir, { recursive: true });

  // Always ship plugin.json alongside the files — keeps the installed
  // directory self-describing, so phase-2 update can read it back.
  const toCopy = resolved.files.includes('plugin.json')
    ? resolved.files
    : ['plugin.json', ...resolved.files];

  const installed: string[] = [];
  for (const file of toCopy) {
    const from = join(resolved.sourceDir, file);
    if (!existsSync(from)) {
      throw new Error(`${resolved.manifest.type}/${resolved.manifest.name}: declared file '${file}' not found at ${from}`);
    }
    const destName = file === 'gitignore' ? '.gitignore' : file;
    const to = join(targetDir, destName);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    if (destName === 'install.sh') {
      try { chmodSync(to, 0o755); } catch { /* best-effort */ }
    }
    installed.push(destName);
  }

  log(`installed:  ${resolved.manifest.type}/${resolved.manifest.name} (${installed.length} file${installed.length === 1 ? '' : 's'})`);
  return { targetDir, filesInstalled: installed };
}

export interface InstalledPlugin {
  type: PluginType;
  name: string;
  /** Absolute path of the installed plugin directory. */
  dir: string;
  /** Parsed plugin.json from the installed dir. */
  manifest: PluginManifest;
  /** Resolved file list from the installed manifest. */
  files: string[];
}

/**
 * Walk `.nanogent/<type>/<name>/` and return every directory that contains a
 * valid plugin.json. Dirs without one are logged and skipped — they may be
 * in-progress scaffolding, or a stale v0.9.0 install that predates the
 * plugin.json requirement (see the 0.9.0 → 0.10.0 migration note).
 */
export function listInstalledPlugins(
  nanogentDir: string,
  log: (msg: string) => void = () => { /* silent */ },
): InstalledPlugin[] {
  const out: InstalledPlugin[] = [];
  for (const type of PLUGIN_TYPES) {
    const rootDir = join(nanogentDir, type);
    if (!existsSync(rootDir)) continue;
    const names = readdirSync(rootDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
    for (const name of names) {
      const dir = join(rootDir, name);
      const manifestPath = join(dir, 'plugin.json');
      if (!existsSync(manifestPath)) {
        log(`warning:    ${type}/${name} has no plugin.json — skipping (run \`nanogent update\` or reinstall)`);
        continue;
      }
      let manifest: PluginManifest;
      try {
        manifest = readPluginManifest(dir);
      } catch (e) {
        log(`warning:    ${type}/${name}/plugin.json invalid — skipping (${(e as Error).message})`);
        continue;
      }
      if (manifest.type !== type || manifest.name !== name) {
        log(`warning:    ${type}/${name}/plugin.json declares ${manifest.type}/${manifest.name} (mismatch) — skipping`);
        continue;
      }
      const files = manifest.files ?? defaultPluginFiles(dir).filter(f => f !== 'plugin.json');
      out.push({ type, name, dir, manifest, files });
    }
  }
  return out;
}

/**
 * Compose the full update entry list: CORE_MANIFEST plus one plugin-typed
 * entry per file in each installed plugin. Drives runUpdate's default path
 * when no explicit manifest is supplied.
 *
 * For each installed plugin we try to locate a shipped source at
 * `<tplRoot>/plugins/<type>/<name>/`. If that's missing the plugin is
 * third-party (or renamed) — we log it and skip, because we have nothing
 * to diff against. Plugin files the operator added locally but that aren't
 * in the shipped source are likewise skipped (`(file missing in shipped
 * source)`).
 */
export function composeUpdateEntries(
  tplRoot: string,
  cwd: string,
  log: (msg: string) => void,
): ManifestEntry[] {
  const entries: ManifestEntry[] = [...CORE_MANIFEST];
  const nanogentDir = join(cwd, '.nanogent');
  if (!existsSync(nanogentDir)) return entries;

  const installed = listInstalledPlugins(nanogentDir, log);
  for (const p of installed) {
    const shippedSourceRel = `${p.type}/${p.name}`;
    const shippedSource = join(tplRoot, shippedSourceRel);
    if (!existsSync(shippedSource)) {
      log(`skipped:    ${p.type}/${p.name}/* (no shipped source — third-party plugin)`);
      continue;
    }
    // Always include plugin.json so phase 2 can sync manifest changes. Files
    // are source-side names (matching manifest.files); the installer applied
    // the gitignore→.gitignore rename on the way in, so phase 2 applies the
    // same forward rename when computing the installed destination.
    const filesToCheck = p.files.includes('plugin.json') ? p.files : ['plugin.json', ...p.files];
    for (const f of filesToCheck) {
      const srcRel = `${shippedSourceRel}/${f}`;
      const src = join(tplRoot, srcRel);
      if (!existsSync(src)) {
        log(`skipped:    .nanogent/${p.type}/${p.name}/${f} (file missing in shipped source)`);
        continue;
      }
      const destName = f === 'gitignore' ? '.gitignore' : f;
      entries.push({
        src: srcRel,
        dest: `.nanogent/${p.type}/${p.name}/${destName}`,
        type: 'plugin',
      });
    }
  }
  return entries;
}

export interface UpdateCounts {
  updated: number;
  created: number;
  preserved: number;
  skipped: number;
  identical: number;
}

export interface UpdateOptions {
  force: boolean;
  dryRun: boolean;
  manifest?: ManifestEntry[];
  templateDir?: string;
  cwd?: string;
  logger?: (msg: string) => void;
}

/**
 * Iterate the manifest with type-aware update semantics.
 *
 *   code:   always overwrite
 *   plugin: overwrite only if unmodified locally (byte-identical); otherwise
 *           skip and surface a diff hint — pass --force to override
 *   config: never overwrite; only create if missing
 *
 * Returns a summary object for the final report.
 */
export function runUpdate(opts: UpdateOptions): UpdateCounts {
  const { force, dryRun } = opts;
  const tplRoot = opts.templateDir ?? tplDir;
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.logger ?? ((msg: string) => { console.log(msg); });

  // Default composition: core files + one plugin-typed entry per file in
  // every installed plugin (discovered dynamically). Tests pass an explicit
  // `manifest` to exercise a single entry type in isolation.
  const manifest = opts.manifest ?? composeUpdateEntries(tplRoot, cwd, log);

  const counts: UpdateCounts = { updated: 0, created: 0, preserved: 0, skipped: 0, identical: 0 };
  const skippedPaths: string[] = [];

  for (const { src, dest, type } of manifest) {
    const from = join(tplRoot, src);
    const to   = join(cwd, dest);
    const missing = !existsSync(to);

    // Missing files are created regardless of type — new version introduced a
    // new file, operator wants it.
    if (missing) {
      if (!dryRun) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
      log(`created:    ${dest}`);
      counts.created++;
      continue;
    }

    if (type === 'config') {
      log(`preserved:  ${dest} (user config)`);
      counts.preserved++;
      continue;
    }

    if (type === 'code') {
      if (!dryRun) copyFileSync(from, to);
      log(`updated:    ${dest}`);
      counts.updated++;
      continue;
    }

    if (type === 'plugin') {
      const current = readFileSync(to);
      const shipped = readFileSync(from);
      if (current.equals(shipped)) {
        log(`unchanged:  ${dest}`);
        counts.identical++;
        continue;
      }
      if (force) {
        if (!dryRun) copyFileSync(from, to);
        log(`updated:    ${dest} (forced overwrite of local changes)`);
        counts.updated++;
      } else {
        log(`skipped:    ${dest} (locally modified — pass --force to overwrite)`);
        skippedPaths.push(dest);
        counts.skipped++;
      }
      continue;
    }

    log(`? unknown type '${type as string}' for ${dest} (skipping)`);
  }

  log('');
  log(
    `Summary: ${counts.updated} updated, ${counts.created} created, ` +
    `${counts.identical} already up-to-date, ${counts.preserved} preserved, ${counts.skipped} skipped`,
  );

  if (skippedPaths.length > 0) {
    log('');
    log('Skipped files had local modifications. To compare one against the shipped version:');
    for (const p of skippedPaths) {
      const src = manifest.find(m => m.dest === p)?.src;
      if (src) log(`  diff ${p} ${join(tplRoot, src)}`);
    }
    log('');
    log('To overwrite all locally-modified plugin files, re-run with --force.');
  }

  if (dryRun) {
    log('');
    log('(dry run — no files were actually changed)');
  }

  return counts;
}

// ---------------------------------------------------------------------------
// nanogent build — compose Dockerfile.generated from base + plugin install.sh
// ---------------------------------------------------------------------------
//
// The core Dockerfile ships only the base image and apt baseline; every
// container-side dependency a plugin needs lives next to that plugin as an
// install.sh. `nanogent build` walks the plugin tree, finds every install.sh,
// and splices matching COPY + RUN lines into the marker slot in the base
// Dockerfile. The result lands at .nanogent/Dockerfile.generated, which is
// what docker-compose.yml builds from.
//
// This keeps the core closed for modification: swapping tools/claude for a
// tools/opencode plugin ships the right dependency without anyone editing
// the base Dockerfile.

const BUILD_MARKER = '# __NANOGENT_PLUGIN_INSTALLS__';
const BASE_DOCKERFILE_REL = '.nanogent/Dockerfile';
const GENERATED_DOCKERFILE_REL = '.nanogent/Dockerfile.generated';

export interface PluginInstall {
  /** Plugin root directory, e.g. 'tools'. */
  root: string;
  /** Plugin folder name, e.g. 'claude'. */
  name: string;
  /** Path relative to .nanogent/, e.g. 'tools/claude/install.sh'. */
  scriptPath: string;
}

/**
 * Optional per-plugin container resource hint. Each plugin can ship a
 * `resources.json` next to `install.sh` declaring the minimum RAM/CPU its
 * tooling needs inside the container. `nanogent build` reads these, aggregates
 * via max() (plugins share one container, they don't each get their own), and
 * emits an advisory line — it never edits `docker-compose.yml`. Missing,
 * malformed, or partial files are fine: discovery warns and skips.
 */
export interface PluginResources {
  root: string;
  name: string;
  /** Path relative to .nanogent/, e.g. 'tools/claude/resources.json'. */
  resourcesPath: string;
  minMemoryMb?: number;
  minCpus?: number;
  note?: string;
}

export interface BuildOptions {
  cwd?: string;
  logger?: (msg: string) => void;
}

export interface BuildResult {
  /** Absolute path of the file we wrote. */
  outputPath: string;
  /** Plugins that contributed an install step. */
  installs: PluginInstall[];
  /** Plugins that shipped a resources.json advisory. */
  resources: PluginResources[];
}

/**
 * Scan .nanogent/<root>/*\/install.sh and return a stable-ordered list.
 * Stable ordering matters because the generated Dockerfile is content-addressed
 * by Docker's layer cache — reshuffling would bust the cache for no reason.
 */
export function discoverPluginInstalls(nanogentDir: string): PluginInstall[] {
  const installs: PluginInstall[] = [];
  for (const root of PLUGIN_TYPES) {
    const rootDir = join(nanogentDir, root);
    if (!existsSync(rootDir)) continue;
    const entries = readdirSync(rootDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
    for (const name of entries) {
      const script = join(rootDir, name, 'install.sh');
      if (!existsSync(script)) continue;
      installs.push({ root, name, scriptPath: `${root}/${name}/install.sh` });
    }
  }
  return installs;
}

/**
 * Scan .nanogent/<root>/*\/resources.json for optional per-plugin resource
 * hints. Missing files → silently skipped (advisory is opt-in). Malformed
 * JSON or unexpected types → warn via `log` and skip that one file; a bad
 * advisory should never block `nanogent build`. Returns the same stable
 * order as `discoverPluginInstalls` so build output is deterministic.
 */
export function discoverPluginResources(
  nanogentDir: string,
  log: (msg: string) => void = () => { /* silent */ },
): PluginResources[] {
  const out: PluginResources[] = [];
  for (const root of PLUGIN_TYPES) {
    const rootDir = join(nanogentDir, root);
    if (!existsSync(rootDir)) continue;
    const entries = readdirSync(rootDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort();
    for (const name of entries) {
      const file = join(rootDir, name, 'resources.json');
      if (!existsSync(file)) continue;
      const rel = `${root}/${name}/resources.json`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        log(`warning:    ${rel} is not valid JSON — skipping (${(e as Error).message})`);
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        log(`warning:    ${rel} must be a JSON object — skipping`);
        continue;
      }
      const obj = parsed as Record<string, unknown>;
      const entry: PluginResources = { root, name, resourcesPath: rel };
      if ('minMemoryMb' in obj) {
        if (typeof obj.minMemoryMb === 'number' && obj.minMemoryMb > 0 && Number.isFinite(obj.minMemoryMb)) {
          entry.minMemoryMb = obj.minMemoryMb;
        } else {
          log(`warning:    ${rel} has non-numeric/non-positive minMemoryMb — ignoring field`);
        }
      }
      if ('minCpus' in obj) {
        if (typeof obj.minCpus === 'number' && obj.minCpus > 0 && Number.isFinite(obj.minCpus)) {
          entry.minCpus = obj.minCpus;
        } else {
          log(`warning:    ${rel} has non-numeric/non-positive minCpus — ignoring field`);
        }
      }
      if (typeof obj.note === 'string') entry.note = obj.note;
      out.push(entry);
    }
  }
  return out;
}

export interface AggregatedResources {
  /** max() across all plugins that declared minMemoryMb. undefined if none did. */
  minMemoryMb?: number;
  /** Plugin name that set the max memory floor — used in the advisory line. */
  minMemoryMbFrom?: string;
  minCpus?: number;
  minCpusFrom?: string;
}

/**
 * Aggregate per-plugin resources with max() semantics. Plugins share one
 * container, so the container's floor is the hungriest plugin's floor — not
 * the sum. Empty input → empty object (no advisory to emit).
 */
export function aggregatePluginResources(resources: PluginResources[]): AggregatedResources {
  const agg: AggregatedResources = {};
  for (const r of resources) {
    if (r.minMemoryMb !== undefined && (agg.minMemoryMb === undefined || r.minMemoryMb > agg.minMemoryMb)) {
      agg.minMemoryMb = r.minMemoryMb;
      agg.minMemoryMbFrom = `${r.root}/${r.name}`;
    }
    if (r.minCpus !== undefined && (agg.minCpus === undefined || r.minCpus > agg.minCpus)) {
      agg.minCpus = r.minCpus;
      agg.minCpusFrom = `${r.root}/${r.name}`;
    }
  }
  return agg;
}

/**
 * Cheap, grep-based check for whether docker-compose.yml already declares
 * any resource limits. We don't parse YAML — we just look for the common
 * keys operators use. A false negative here just means we print the
 * advisory when the operator has already acted on it; no harm done.
 */
function composeMentionsResourceLimits(composeContent: string): boolean {
  return /^\s*(mem_limit|cpus|deploy)\s*:/m.test(composeContent);
}

/** Emit the COPY + RUN pair for a single plugin install. */
function renderInstallBlock(install: PluginInstall): string {
  const containerPath = `/tmp/nanogent-install/${install.scriptPath}`;
  return [
    `# ${install.root}/${install.name}`,
    `COPY ${install.scriptPath} ${containerPath}`,
    `RUN bash ${containerPath}`,
  ].join('\n');
}

/**
 * Splice plugin install blocks into the base Dockerfile in place of the
 * marker line. Throws if the marker is missing — a silent omission would
 * leave users wondering why their plugin deps never make it into the image.
 */
export function composeDockerfile(baseContent: string, installs: PluginInstall[]): string {
  if (!baseContent.includes(BUILD_MARKER)) {
    throw new Error(
      `base Dockerfile is missing the '${BUILD_MARKER}' marker line. ` +
      'Restore it (see the shipped template/Dockerfile) or `nanogent build` ' +
      'has nowhere to inject plugin install steps.',
    );
  }

  const header = [
    '# Generated by `nanogent build` — do not edit.',
    '# Source: .nanogent/Dockerfile + plugin install.sh files.',
    installs.length > 0
      ? `# Plugins contributing install steps: ${installs.map(i => `${i.root}/${i.name}`).join(', ')}`
      : '# No plugins contributed install steps.',
  ].join('\n');

  const body = installs.length > 0
    ? installs.map(renderInstallBlock).join('\n\n')
    : '# (no plugin install.sh files found — base image is used as-is)';

  return baseContent.replace(BUILD_MARKER, `${header}\n\n${body}`);
}

/**
 * Run the build: read the base Dockerfile, discover plugin installs, write
 * Dockerfile.generated. Returns the list of contributing plugins so callers
 * (init, start --docker) can log what got baked in.
 */
export function runBuild(opts: BuildOptions = {}): BuildResult {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.logger ?? ((msg: string) => { console.log(msg); });

  const basePath = join(cwd, BASE_DOCKERFILE_REL);
  if (!existsSync(basePath)) {
    throw new Error(`${BASE_DOCKERFILE_REL} not found — run \`nanogent init\` first`);
  }

  const nanogentDir = join(cwd, '.nanogent');
  const baseContent = readFileSync(basePath, 'utf8');
  const installs = discoverPluginInstalls(nanogentDir);
  const generated = composeDockerfile(baseContent, installs);

  const outputPath = join(cwd, GENERATED_DOCKERFILE_REL);
  writeFileSync(outputPath, generated);

  if (installs.length === 0) {
    log('built:      .nanogent/Dockerfile.generated (no plugin install.sh found)');
  } else {
    log(`built:      .nanogent/Dockerfile.generated (${installs.length} plugin install step${installs.length === 1 ? '' : 's'})`);
    for (const i of installs) {
      log(`  + ${i.root}/${i.name}/install.sh`);
    }
  }

  // Optional per-plugin resource advisories. Opt-in via resources.json next
  // to install.sh; we never edit docker-compose.yml, we just surface the
  // numbers at build time so the operator can act on them.
  const resources = discoverPluginResources(nanogentDir, log);
  const agg = aggregatePluginResources(resources);
  if (resources.length > 0) {
    const composePath = join(nanogentDir, 'docker-compose.yml');
    const composeSet = existsSync(composePath)
      ? composeMentionsResourceLimits(readFileSync(composePath, 'utf8'))
      : false;

    log('');
    log(`advisory:   ${resources.length} plugin${resources.length === 1 ? '' : 's'} declared resource hints`);
    for (const r of resources) {
      const bits: string[] = [];
      if (r.minMemoryMb !== undefined) bits.push(`${r.minMemoryMb} MB`);
      if (r.minCpus !== undefined) bits.push(`${r.minCpus} cpus`);
      const suffix = r.note ? ` — ${r.note}` : '';
      log(`  + ${r.root}/${r.name}: ${bits.length > 0 ? bits.join(', ') : '(no numeric fields)'}${suffix}`);
    }
    if (agg.minMemoryMb !== undefined || agg.minCpus !== undefined) {
      const parts: string[] = [];
      if (agg.minMemoryMb !== undefined) {
        parts.push(`≥ ${agg.minMemoryMb} MB memory (from ${agg.minMemoryMbFrom})`);
      }
      if (agg.minCpus !== undefined) {
        parts.push(`≥ ${agg.minCpus} cpus (from ${agg.minCpusFrom})`);
      }
      log(`  → container floor: ${parts.join(', ')}`);
      if (!composeSet) {
        log('  → .nanogent/docker-compose.yml has no mem_limit/cpus set; add limits there if the host needs them');
      } else {
        log('  → .nanogent/docker-compose.yml already declares resource limits; verify they meet the floor above');
      }
    }
  }

  return { outputPath, installs, resources };
}

/**
 * Fail fast if docker is missing from PATH. `nanogent start` has no fallback
 * runtime — without docker there's nothing to run — so produce a clear hint
 * instead of letting `spawn('docker', ...)` emit a bare ENOENT.
 */
function requireDocker(): void {
  const probe = spawnSync('docker', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    console.error('docker not found on PATH — install Docker Desktop or docker + compose and retry');
    process.exit(1);
  }
}

/** Simple blocking stdin prompt, no dependencies. */
function confirm(prompt: string): boolean {
  process.stdout.write(prompt);
  const buf = Buffer.alloc(32);
  let n = 0;
  try { n = readSync(0, buf, 0, buf.length, null); } catch { return false; }
  const ans = buf.toString('utf8', 0, n).trim().toLowerCase();
  return ans === 'y' || ans === 'yes';
}

// Only run the CLI dispatch when this file is executed directly (not when
// imported from tests).
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (!invokedDirectly) {
  // Imported as a module (e.g. from tests). Skip top-level CLI work.
} else if (cmd === 'init') {
  // Phase 1: drop the core files — runtime, docker harness, config seeds.
  copyFromManifest(CORE_MANIFEST);

  // Phase 2: load a profile (default = the shipped `default.json`) and
  // install each plugin it lists. `--profile <path>` points at a custom
  // profile file — absolute or relative to cwd. Operators can author their
  // own profiles to ship an opinionated plugin set for their team.
  const profileIdx = args.indexOf('--profile');
  const profileArg = profileIdx >= 0 ? args[profileIdx + 1] : undefined;
  const profilePath = profileArg
    ? (isAbsolute(profileArg) ? profileArg : pathResolve(process.cwd(), profileArg))
    : join(tplDir, 'profiles', 'default.json');
  try {
    const profile = loadProfile(profilePath);
    const profileDir = dirname(profilePath);
    const nanogentDir = join(process.cwd(), '.nanogent');
    console.log(`profile:    ${profile.name} (${profile.plugins.length} plugin${profile.plugins.length === 1 ? '' : 's'})`);
    for (const { ref } of profile.plugins) {
      try {
        const resolved = resolvePlugin(ref, profileDir);
        installPlugin(resolved, nanogentDir);
      } catch (e) {
        console.error(`init failed on plugin '${ref}': ${(e as Error).message}`);
        process.exit(1);
      }
    }
  } catch (e) {
    console.error(`init failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // Phase 3: seed Dockerfile.generated so `nanogent start` works on a fresh
  // init without an extra step. Pure file-gen — no docker daemon needed.
  try { runBuild(); } catch (e) { console.error(`build warning: ${(e as Error).message}`); }
  console.log([
    '',
    'next:',
    '  cp .nanogent/.env.example .nanogent/.env',
    '  $EDITOR .nanogent/.env           # fill in TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY',
    '  $EDITOR .nanogent/contacts.json  # add yourself as an operator with your Telegram chatId',
    '  $EDITOR .nanogent/prompt.md      # tailor the system prompt for this project / client',
    '  nanogent start',
  ].join('\n'));
} else if (cmd === 'plugin') {
  // `nanogent plugin <sub> [...]` — lifecycle management for the OCP-clean
  // plugin system. Splits the `add` / `remove` / `list` verbs so the top
  // level of the CLI stays uncluttered.
  const sub = args[1];
  const nanogentDir = join(process.cwd(), '.nanogent');
  if (!existsSync(nanogentDir)) {
    console.error('.nanogent/ not found — run `nanogent init` first');
    process.exit(1);
  }
  if (sub === 'list') {
    const installed = listInstalledPlugins(nanogentDir, (m) => { console.log(m); });
    if (installed.length === 0) {
      console.log('(no plugins installed)');
    } else {
      for (const p of installed) {
        const desc = p.manifest.description ? ` — ${p.manifest.description}` : '';
        console.log(`  ${p.type}/${p.name}${desc}`);
      }
    }
  } else if (sub === 'add') {
    const ref = args[2];
    if (!ref) {
      console.error('usage: nanogent plugin add <path> [--force]');
      process.exit(1);
    }
    const force = args.includes('--force') || args.includes('-f');
    try {
      const resolved = resolvePlugin(ref, process.cwd());
      installPlugin(resolved, nanogentDir, { force });
      // Re-seed Dockerfile.generated so any new install.sh makes it into
      // the next image build without a manual `nanogent build`.
      try { runBuild(); } catch (e) { console.error(`build warning: ${(e as Error).message}`); }
    } catch (e) {
      console.error(`plugin add failed: ${(e as Error).message}`);
      process.exit(1);
    }
  } else if (sub === 'remove') {
    const name = args[2];
    if (!name) {
      console.error('usage: nanogent plugin remove <name> [-f]');
      process.exit(1);
    }
    const installed = listInstalledPlugins(nanogentDir);
    const matches = installed.filter(p => p.name === name);
    if (matches.length === 0) {
      console.error(`no installed plugin named '${name}' — run \`nanogent plugin list\` to see what's installed`);
      process.exit(1);
    }
    if (matches.length > 1) {
      const where = matches.map(p => `${p.type}/${p.name}`).join(', ');
      console.error(`multiple installed plugins named '${name}' (${where}) — pass a <type>/<name> prefix to disambiguate: nanogent plugin remove <type>/<name>`);
      process.exit(1);
    }
    const target = matches[0]!;
    const force = args.includes('--force') || args.includes('-f');
    if (!force) {
      const ok = confirm(`Remove ${target.type}/${target.name}? [y/N]: `);
      if (!ok) {
        console.log('aborted');
        process.exit(0);
      }
    }
    rmSync(target.dir, { recursive: true, force: true });
    console.log(`removed:    ${target.type}/${target.name}`);
    try { runBuild(); } catch (e) { console.error(`build warning: ${(e as Error).message}`); }
  } else {
    console.error('usage: nanogent plugin <list|add|remove> [...]');
    process.exit(1);
  }
} else if (cmd === 'build') {
  if (!existsSync(join(process.cwd(), '.nanogent'))) {
    console.error('.nanogent/ not found — run `nanogent init` first');
    process.exit(1);
  }
  try {
    runBuild();
  } catch (e) {
    console.error(`build failed: ${(e as Error).message}`);
    process.exit(1);
  }
} else if (cmd === 'start') {
  const composePath = join(process.cwd(), '.nanogent', 'docker-compose.yml');
  if (!existsSync(composePath)) {
    console.error('.nanogent/docker-compose.yml not found — run `nanogent init` first');
    process.exit(1);
  }
  requireDocker();
  // Auto-build Dockerfile.generated if missing (e.g. first start after a
  // fresh checkout that skipped `nanogent init`). Cheap file-gen; compose
  // then does the real image build.
  const generatedPath = join(process.cwd(), '.nanogent', 'Dockerfile.generated');
  if (!existsSync(generatedPath)) {
    try {
      runBuild();
    } catch (e) {
      console.error(`build failed: ${(e as Error).message}`);
      process.exit(1);
    }
  }
  spawn('docker', ['compose', '-f', composePath, 'up', '--build'], { stdio: 'inherit' })
    .on('exit', c => { process.exit(c ?? 0); });
} else if (cmd === 'update') {
  if (!existsSync(join(process.cwd(), '.nanogent'))) {
    console.error('.nanogent/ not found — run `nanogent init` first');
    process.exit(1);
  }
  const force  = args.includes('--force') || args.includes('-f');
  const dryRun = args.includes('--dry-run') || args.includes('-n');
  runUpdate({ force, dryRun });
} else if (cmd === 'uninstall') {
  const target = join(process.cwd(), '.nanogent');
  if (!existsSync(target)) {
    console.log('.nanogent/ not found — nothing to uninstall');
    process.exit(0);
  }
  const force = args.includes('--force') || args.includes('-f');
  if (!force) {
    const ok = confirm(
      'This will permanently delete .nanogent/\n' +
      '(including your prompt, config, tools, chat history, and learnings).\n' +
      'Proceed? [y/N]: ',
    );
    if (!ok) {
      console.log('aborted');
      process.exit(0);
    }
  }
  rmSync(target, { recursive: true, force: true });
  console.log('removed: .nanogent/');
} else {
  console.log(usage);
  if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(1);
}
