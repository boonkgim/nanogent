#!/usr/bin/env node
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  readSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const here = dirname(fileURLToPath(import.meta.url));
const tplDir = join(here, '..', 'template');

const usage = `
nanogent — per-project chat agent with pluggable tools, channels, and providers

  nanogent init             drop everything into .nanogent/ (runtime, prompt, config, contacts, tool, channel, provider)
  nanogent build            regenerate .nanogent/Dockerfile.generated from the base Dockerfile + plugin install.sh files
  nanogent start            run the listener — reads .nanogent/config.json to choose node or docker mode
  nanogent start --docker   force docker mode (ignores config.json)
  nanogent start --node     force node mode (ignores config.json)
  nanogent update           update runtime code; preserves prompt / config / contacts / local plugin edits
  nanogent update --force   also overwrite locally-modified plugin files
  nanogent update --dry-run show what update would do, without changing files
  nanogent uninstall        delete .nanogent/ after confirmation
  nanogent uninstall -f     delete .nanogent/ without confirmation

after init:
  1. cp .nanogent/.env.example .nanogent/.env
  2. fill TELEGRAM_BOT_TOKEN and ANTHROPIC_API_KEY in .env
  3. edit .nanogent/contacts.json — replace the REPLACE_WITH_YOUR_TELEGRAM_* placeholders
  4. edit .nanogent/prompt.md for this project / client
  5. optionally flip "docker": true in .nanogent/config.json
  6. nanogent start

in-chat (once running):
  any text    → routed through the chat agent, which may delegate to tools
  /status     current background job
  /cancel     cancel running job
  /clear      wipe chat history for the current chat
  /help       show command list

to stop:    Ctrl+C   (or: kill <pid> / pm2 stop / docker compose down)
to update:  nanogent update
to remove:  nanogent uninstall   (or: rm -rf .nanogent)
`;

type EntryType = 'code' | 'plugin' | 'config';

interface ManifestEntry {
  src: string;
  dest: string;
  type: EntryType;
}

/**
 * Manifest. Every template file maps to a destination, tagged with a type
 * that determines how `nanogent update` handles it:
 *
 *   code   — always overwritten on update. No one should be customising these.
 *   plugin — overwritten only if the file is byte-identical to what we ship
 *            (no local modifications). Lets bug fixes reach users while
 *            preserving any customisations operators have made.
 *   config — never touched by update; only created if missing. Operator-owned.
 */
export const MANIFEST: ManifestEntry[] = [
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

  // Default tool (customisable, but update if unmodified)
  { src: 'tools/claude/index.ts',  dest: '.nanogent/tools/claude/index.ts',  type: 'plugin' },
  { src: 'tools/claude/README.md', dest: '.nanogent/tools/claude/README.md', type: 'plugin' },
  { src: 'tools/claude/install.sh', dest: '.nanogent/tools/claude/install.sh', type: 'plugin' },
  { src: 'tools/claude/gitignore', dest: '.nanogent/tools/claude/.gitignore', type: 'plugin' },  // same npm workaround

  // Default channel
  { src: 'channels/telegram/index.ts',  dest: '.nanogent/channels/telegram/index.ts',  type: 'plugin' },
  { src: 'channels/telegram/README.md', dest: '.nanogent/channels/telegram/README.md', type: 'plugin' },

  // Default provider
  { src: 'providers/anthropic/index.ts',  dest: '.nanogent/providers/anthropic/index.ts',  type: 'plugin' },
  { src: 'providers/anthropic/README.md', dest: '.nanogent/providers/anthropic/README.md', type: 'plugin' },

  // Default history store (raw append-only message log)
  { src: 'history/jsonl/index.ts',  dest: '.nanogent/history/jsonl/index.ts',  type: 'plugin' },
  { src: 'history/jsonl/README.md', dest: '.nanogent/history/jsonl/README.md', type: 'plugin' },

  // Default memory plugin (indexer + retriever over the history store)
  { src: 'memory/naive/index.ts',  dest: '.nanogent/memory/naive/index.ts',  type: 'plugin' },
  { src: 'memory/naive/README.md', dest: '.nanogent/memory/naive/README.md', type: 'plugin' },

  // Default scheduler plugin (proactive time-based triggers)
  { src: 'scheduler/jsonl/index.ts',  dest: '.nanogent/scheduler/jsonl/index.ts',  type: 'plugin' },
  { src: 'scheduler/jsonl/README.md', dest: '.nanogent/scheduler/jsonl/README.md', type: 'plugin' },

  // Agent-facing schedule tool (pairs with the scheduler plugin)
  { src: 'tools/schedule/index.ts',  dest: '.nanogent/tools/schedule/index.ts',  type: 'plugin' },
  { src: 'tools/schedule/README.md', dest: '.nanogent/tools/schedule/README.md', type: 'plugin' },
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
  const manifest = opts.manifest ?? MANIFEST;
  const tplRoot = opts.templateDir ?? tplDir;
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.logger ?? ((msg: string) => { console.log(msg); });

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

/** Directories under .nanogent/ whose immediate children are plugin folders. */
const PLUGIN_ROOTS = [
  'tools', 'channels', 'providers', 'history', 'memory', 'scheduler',
] as const;

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
  for (const root of PLUGIN_ROOTS) {
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
  for (const root of PLUGIN_ROOTS) {
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

/** Read .nanogent/config.json if present, return empty object otherwise. */
function readConfig(): { docker?: boolean } {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), '.nanogent', 'config.json'), 'utf8')) as { docker?: boolean };
  } catch {
    return {};
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
  copyFromManifest(MANIFEST);
  // npm pack discards the executable bit, so restore it on any install.sh
  // the manifest just laid down. Matches the approach we already use for
  // .gitignore (shipped as `gitignore`, renamed on install).
  for (const { dest } of MANIFEST) {
    if (dest.endsWith('/install.sh')) {
      try { chmodSync(join(process.cwd(), dest), 0o755); } catch { /* best-effort */ }
    }
  }
  // Seed Dockerfile.generated so `nanogent start --docker` works on a fresh
  // init without an extra step. The build is pure file-gen (no docker
  // needed), so this is safe on any host.
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
  // Mode selection: explicit flag > config.json > node default
  const explicitDocker = args.includes('--docker');
  const explicitNode   = args.includes('--node');
  let useDocker: boolean;
  if (explicitDocker) useDocker = true;
  else if (explicitNode) useDocker = false;
  else useDocker = !!readConfig().docker;

  if (useDocker) {
    const composePath = join(process.cwd(), '.nanogent', 'docker-compose.yml');
    if (!existsSync(composePath)) {
      console.error('.nanogent/docker-compose.yml not found — run `nanogent init` first');
      process.exit(1);
    }
    // Auto-build Dockerfile.generated on first docker start, or after an
    // update that bumped the base but didn't touch plugin installs. Cheap
    // file-gen; docker-compose then does the real image build.
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
  } else {
    const script = join(process.cwd(), '.nanogent', 'nanogent.ts');
    if (!existsSync(script)) {
      console.error('.nanogent/nanogent.ts not found — run `nanogent init` first');
      process.exit(1);
    }
    spawn(process.execPath, [script], { stdio: 'inherit' })
      .on('exit', c => { process.exit(c ?? 0); });
  }
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
