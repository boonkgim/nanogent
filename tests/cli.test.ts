// Unit tests for runUpdate's type-aware semantics (code/plugin/config).
// Uses a real temp directory rather than mocking fs, so we test the same
// fs calls the production code uses.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  aggregatePluginResources, composeDockerfile, discoverPluginInstalls,
  discoverPluginResources, runBuild, runUpdate,
} from '../bin/cli.ts';

interface Fixture {
  tpl: string;
  cwd: string;
  cleanup: () => void;
  logs: string[];
  log: (msg: string) => void;
}

function setupFixture(): Fixture {
  const tpl = mkdtempSync(join(tmpdir(), 'nanogent-update-tpl-'));
  const cwd = mkdtempSync(join(tmpdir(), 'nanogent-update-cwd-'));
  const logs: string[] = [];
  return {
    tpl,
    cwd,
    logs,
    log: (msg: string) => { logs.push(msg); },
    cleanup: () => {
      rmSync(tpl, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function writeTpl(tpl: string, rel: string, content: string): void {
  const full = join(tpl, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function writeCwd(cwd: string, rel: string, content: string): void {
  const full = join(cwd, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

const manifest = [
  { src: 'nanogent.ts',       dest: '.nanogent/nanogent.ts',       type: 'code' as const },
  { src: 'prompt.md',         dest: '.nanogent/prompt.md',         type: 'config' as const },
  { src: 'tools/claude/index.ts', dest: '.nanogent/tools/claude/index.ts', type: 'plugin' as const },
];

describe('runUpdate', () => {
  it('code files are always overwritten', () => {
    const f = setupFixture();
    try {
      writeTpl(f.tpl, 'nanogent.ts', 'VERSION_2');
      writeTpl(f.tpl, 'prompt.md', 'shipped-prompt');
      writeTpl(f.tpl, 'tools/claude/index.ts', 'shipped-plugin');
      writeCwd(f.cwd, '.nanogent/nanogent.ts', 'VERSION_1_LOCAL_EDIT');
      writeCwd(f.cwd, '.nanogent/prompt.md', 'my-prompt');
      writeCwd(f.cwd, '.nanogent/tools/claude/index.ts', 'shipped-plugin');

      const counts = runUpdate({
        force: false, dryRun: false,
        manifest, templateDir: f.tpl, cwd: f.cwd, logger: f.log,
      });

      assert.equal(counts.updated, 1);
      assert.equal(counts.preserved, 1);
      assert.equal(counts.identical, 1);
      assert.equal(readFileSync(join(f.cwd, '.nanogent/nanogent.ts'), 'utf8'), 'VERSION_2');
    } finally { f.cleanup(); }
  });

  it('config files are never touched', () => {
    const f = setupFixture();
    try {
      writeTpl(f.tpl, 'nanogent.ts', 'v2');
      writeTpl(f.tpl, 'prompt.md', 'shipped-prompt');
      writeTpl(f.tpl, 'tools/claude/index.ts', 'shipped-plugin');
      writeCwd(f.cwd, '.nanogent/nanogent.ts', 'v1');
      writeCwd(f.cwd, '.nanogent/prompt.md', 'HEAVILY_CUSTOMIZED_PROMPT');
      writeCwd(f.cwd, '.nanogent/tools/claude/index.ts', 'shipped-plugin');

      runUpdate({
        force: false, dryRun: false,
        manifest, templateDir: f.tpl, cwd: f.cwd, logger: f.log,
      });

      assert.equal(
        readFileSync(join(f.cwd, '.nanogent/prompt.md'), 'utf8'),
        'HEAVILY_CUSTOMIZED_PROMPT',
      );
    } finally { f.cleanup(); }
  });

  it('plugin files skipped when locally modified (no --force)', () => {
    const f = setupFixture();
    try {
      writeTpl(f.tpl, 'nanogent.ts', 'v2');
      writeTpl(f.tpl, 'prompt.md', 'p');
      writeTpl(f.tpl, 'tools/claude/index.ts', 'shipped-plugin');
      writeCwd(f.cwd, '.nanogent/nanogent.ts', 'v1');
      writeCwd(f.cwd, '.nanogent/prompt.md', 'p');
      writeCwd(f.cwd, '.nanogent/tools/claude/index.ts', 'MY_LOCAL_PATCH');

      const counts = runUpdate({
        force: false, dryRun: false,
        manifest, templateDir: f.tpl, cwd: f.cwd, logger: f.log,
      });

      assert.equal(counts.skipped, 1);
      assert.equal(
        readFileSync(join(f.cwd, '.nanogent/tools/claude/index.ts'), 'utf8'),
        'MY_LOCAL_PATCH',
      );
      // Diff hint must include the local and shipped paths
      assert.ok(f.logs.some(l => l.includes('diff') && l.includes('tools/claude/index.ts')));
    } finally { f.cleanup(); }
  });

  it('plugin files overwritten when --force', () => {
    const f = setupFixture();
    try {
      writeTpl(f.tpl, 'nanogent.ts', 'v2');
      writeTpl(f.tpl, 'prompt.md', 'p');
      writeTpl(f.tpl, 'tools/claude/index.ts', 'shipped-plugin-v2');
      writeCwd(f.cwd, '.nanogent/nanogent.ts', 'v1');
      writeCwd(f.cwd, '.nanogent/prompt.md', 'p');
      writeCwd(f.cwd, '.nanogent/tools/claude/index.ts', 'MY_LOCAL_PATCH');

      runUpdate({
        force: true, dryRun: false,
        manifest, templateDir: f.tpl, cwd: f.cwd, logger: f.log,
      });

      assert.equal(
        readFileSync(join(f.cwd, '.nanogent/tools/claude/index.ts'), 'utf8'),
        'shipped-plugin-v2',
      );
    } finally { f.cleanup(); }
  });

  it('plugin files unchanged when byte-identical', () => {
    const f = setupFixture();
    try {
      writeTpl(f.tpl, 'nanogent.ts', 'v2');
      writeTpl(f.tpl, 'prompt.md', 'p');
      writeTpl(f.tpl, 'tools/claude/index.ts', 'shipped-plugin-v2');
      writeCwd(f.cwd, '.nanogent/nanogent.ts', 'v1');
      writeCwd(f.cwd, '.nanogent/prompt.md', 'p');
      writeCwd(f.cwd, '.nanogent/tools/claude/index.ts', 'shipped-plugin-v2');

      const counts = runUpdate({
        force: false, dryRun: false,
        manifest, templateDir: f.tpl, cwd: f.cwd, logger: f.log,
      });

      assert.equal(counts.identical, 1);
      assert.equal(counts.skipped, 0);
    } finally { f.cleanup(); }
  });

  it('missing destination files are created regardless of type', () => {
    const f = setupFixture();
    try {
      writeTpl(f.tpl, 'nanogent.ts', 'v2');
      writeTpl(f.tpl, 'prompt.md', 'shipped-prompt');
      writeTpl(f.tpl, 'tools/claude/index.ts', 'shipped-plugin');
      // No cwd files at all → everything missing

      const counts = runUpdate({
        force: false, dryRun: false,
        manifest, templateDir: f.tpl, cwd: f.cwd, logger: f.log,
      });

      assert.equal(counts.created, 3);
      assert.ok(existsSync(join(f.cwd, '.nanogent/nanogent.ts')));
      assert.ok(existsSync(join(f.cwd, '.nanogent/prompt.md')));
      assert.ok(existsSync(join(f.cwd, '.nanogent/tools/claude/index.ts')));
    } finally { f.cleanup(); }
  });

  it('dry-run does not modify any files', () => {
    const f = setupFixture();
    try {
      writeTpl(f.tpl, 'nanogent.ts', 'v2');
      writeTpl(f.tpl, 'prompt.md', 'shipped-prompt');
      writeTpl(f.tpl, 'tools/claude/index.ts', 'shipped-plugin-v2');
      writeCwd(f.cwd, '.nanogent/nanogent.ts', 'v1-ORIGINAL');
      writeCwd(f.cwd, '.nanogent/prompt.md', 'my-prompt-ORIGINAL');
      writeCwd(f.cwd, '.nanogent/tools/claude/index.ts', 'shipped-plugin-v1');

      runUpdate({
        force: true, dryRun: true,
        manifest, templateDir: f.tpl, cwd: f.cwd, logger: f.log,
      });

      assert.equal(readFileSync(join(f.cwd, '.nanogent/nanogent.ts'), 'utf8'), 'v1-ORIGINAL');
      assert.equal(readFileSync(join(f.cwd, '.nanogent/prompt.md'), 'utf8'), 'my-prompt-ORIGINAL');
      assert.equal(
        readFileSync(join(f.cwd, '.nanogent/tools/claude/index.ts'), 'utf8'),
        'shipped-plugin-v1',
      );
    } finally { f.cleanup(); }
  });
});

describe('runBuild', () => {
  function setupBuildFixture(): { cwd: string; cleanup: () => void } {
    const cwd = mkdtempSync(join(tmpdir(), 'nanogent-build-'));
    return {
      cwd,
      cleanup: () => { rmSync(cwd, { recursive: true, force: true }); },
    };
  }

  const BASE_DOCKERFILE = [
    'FROM node:24-slim',
    '',
    'RUN apt-get update && apt-get install -y git',
    '',
    '# __NANOGENT_PLUGIN_INSTALLS__',
    '',
    'WORKDIR /workspace',
    '',
    'CMD ["node", ".nanogent/nanogent.ts"]',
    '',
  ].join('\n');

  it('discoverPluginInstalls finds install.sh in all plugin roots and sorts stably', () => {
    const f = setupBuildFixture();
    try {
      // Two plugins with install.sh, one without, plus an unrelated folder
      // (underscore-prefixed) that should be skipped.
      mkdirSync(join(f.cwd, '.nanogent/tools/claude'), { recursive: true });
      mkdirSync(join(f.cwd, '.nanogent/tools/schedule'), { recursive: true });
      mkdirSync(join(f.cwd, '.nanogent/tools/_scratch'), { recursive: true });
      mkdirSync(join(f.cwd, '.nanogent/channels/telegram'), { recursive: true });
      writeFileSync(join(f.cwd, '.nanogent/tools/claude/install.sh'), '#!/bin/bash\necho a\n');
      writeFileSync(join(f.cwd, '.nanogent/tools/_scratch/install.sh'), '#!/bin/bash\necho skip\n');
      writeFileSync(join(f.cwd, '.nanogent/channels/telegram/install.sh'), '#!/bin/bash\necho b\n');
      // tools/schedule has no install.sh — should not appear

      const installs = discoverPluginInstalls(join(f.cwd, '.nanogent'));

      // Order: PLUGIN_ROOTS declaration order (tools, channels, …), then
      // alphabetical plugin name within each root. Stable ordering is what
      // lets Docker's layer cache survive across unrelated plugin additions.
      assert.deepEqual(
        installs.map(i => `${i.root}/${i.name}`),
        ['tools/claude', 'channels/telegram'],
      );
      // Path is relative to .nanogent/
      assert.equal(installs[0]?.scriptPath, 'tools/claude/install.sh');
      assert.equal(installs[1]?.scriptPath, 'channels/telegram/install.sh');
    } finally { f.cleanup(); }
  });

  it('composeDockerfile splices installs into the marker', () => {
    const generated = composeDockerfile(BASE_DOCKERFILE, [
      { root: 'tools', name: 'claude', scriptPath: 'tools/claude/install.sh' },
    ]);

    // Marker is replaced
    assert.ok(!generated.includes('# __NANOGENT_PLUGIN_INSTALLS__'));
    // COPY + RUN emitted
    assert.ok(generated.includes('COPY tools/claude/install.sh /tmp/nanogent-install/tools/claude/install.sh'));
    assert.ok(generated.includes('RUN bash /tmp/nanogent-install/tools/claude/install.sh'));
    // Base lines preserved
    assert.ok(generated.startsWith('FROM node:24-slim'));
    assert.ok(generated.includes('WORKDIR /workspace'));
    assert.ok(generated.trimEnd().endsWith('CMD ["node", ".nanogent/nanogent.ts"]'));
    // Header comment names the contributing plugin
    assert.ok(generated.includes('tools/claude'));
  });

  it('composeDockerfile handles zero plugins gracefully', () => {
    const generated = composeDockerfile(BASE_DOCKERFILE, []);
    assert.ok(!generated.includes('# __NANOGENT_PLUGIN_INSTALLS__'));
    assert.ok(!generated.includes('COPY '));
    assert.ok(!generated.includes('RUN bash '));
    assert.ok(generated.includes('No plugins contributed install steps.'));
    // CMD still last
    assert.ok(generated.trimEnd().endsWith('CMD ["node", ".nanogent/nanogent.ts"]'));
  });

  it('composeDockerfile throws if marker is missing', () => {
    const noMarker = 'FROM node:24-slim\nWORKDIR /workspace\nCMD ["node"]\n';
    assert.throws(
      () => composeDockerfile(noMarker, []),
      /__NANOGENT_PLUGIN_INSTALLS__/,
    );
  });

  it('composeDockerfile emits multiple installs in the order given', () => {
    const generated = composeDockerfile(BASE_DOCKERFILE, [
      { root: 'tools',    name: 'claude',   scriptPath: 'tools/claude/install.sh' },
      { root: 'channels', name: 'telegram', scriptPath: 'channels/telegram/install.sh' },
    ]);
    const cIdx = generated.indexOf('tools/claude/install.sh');
    const tIdx = generated.indexOf('channels/telegram/install.sh');
    assert.ok(cIdx >= 0 && tIdx >= 0);
    assert.ok(cIdx < tIdx, 'plugins should appear in the order discoverPluginInstalls returns');
  });

  it('runBuild writes Dockerfile.generated from base + plugin installs', () => {
    const f = setupBuildFixture();
    try {
      mkdirSync(join(f.cwd, '.nanogent/tools/claude'), { recursive: true });
      writeFileSync(join(f.cwd, '.nanogent/Dockerfile'), BASE_DOCKERFILE);
      writeFileSync(
        join(f.cwd, '.nanogent/tools/claude/install.sh'),
        '#!/bin/bash\nnpm install -g @anthropic-ai/claude-code\n',
      );

      const logs: string[] = [];
      const result = runBuild({ cwd: f.cwd, logger: (m) => { logs.push(m); } });

      assert.equal(result.installs.length, 1);
      assert.equal(result.installs[0]?.name, 'claude');
      const out = readFileSync(join(f.cwd, '.nanogent/Dockerfile.generated'), 'utf8');
      assert.ok(out.includes('COPY tools/claude/install.sh'));
      assert.ok(out.includes('RUN bash /tmp/nanogent-install/tools/claude/install.sh'));
      assert.ok(logs.some(l => l.includes('Dockerfile.generated')));
    } finally { f.cleanup(); }
  });

  it('runBuild succeeds with no plugin install.sh files', () => {
    const f = setupBuildFixture();
    try {
      mkdirSync(join(f.cwd, '.nanogent'), { recursive: true });
      writeFileSync(join(f.cwd, '.nanogent/Dockerfile'), BASE_DOCKERFILE);
      const result = runBuild({ cwd: f.cwd, logger: () => { /* silent */ } });
      assert.equal(result.installs.length, 0);
      const out = readFileSync(join(f.cwd, '.nanogent/Dockerfile.generated'), 'utf8');
      assert.ok(out.includes('No plugins contributed install steps.'));
    } finally { f.cleanup(); }
  });

  it('runBuild throws when base Dockerfile is missing', () => {
    const f = setupBuildFixture();
    try {
      mkdirSync(join(f.cwd, '.nanogent'), { recursive: true });
      assert.throws(
        () => runBuild({ cwd: f.cwd, logger: () => { /* silent */ } }),
        /Dockerfile not found/,
      );
    } finally { f.cleanup(); }
  });
});

describe('plugin resources advisory', () => {
  function setupResFixture(): { cwd: string; cleanup: () => void } {
    const cwd = mkdtempSync(join(tmpdir(), 'nanogent-res-'));
    return { cwd, cleanup: () => { rmSync(cwd, { recursive: true, force: true }); } };
  }

  function writePlugin(cwd: string, root: string, name: string, resJson: string | null): void {
    const dir = join(cwd, '.nanogent', root, name);
    mkdirSync(dir, { recursive: true });
    if (resJson !== null) writeFileSync(join(dir, 'resources.json'), resJson);
  }

  it('discoverPluginResources returns empty when no files exist', () => {
    const f = setupResFixture();
    try {
      writePlugin(f.cwd, 'tools', 'claude', null);
      const out = discoverPluginResources(join(f.cwd, '.nanogent'));
      assert.equal(out.length, 0);
    } finally { f.cleanup(); }
  });

  it('discoverPluginResources parses valid files', () => {
    const f = setupResFixture();
    try {
      writePlugin(f.cwd, 'tools', 'heavy', JSON.stringify({
        minMemoryMb: 4096, minCpus: 2, note: 'needs a real runtime',
      }));
      const out = discoverPluginResources(join(f.cwd, '.nanogent'));
      assert.equal(out.length, 1);
      assert.equal(out[0]?.minMemoryMb, 4096);
      assert.equal(out[0]?.minCpus, 2);
      assert.equal(out[0]?.note, 'needs a real runtime');
      assert.equal(out[0]?.resourcesPath, 'tools/heavy/resources.json');
    } finally { f.cleanup(); }
  });

  it('discoverPluginResources warns and skips malformed JSON without failing', () => {
    const f = setupResFixture();
    try {
      writePlugin(f.cwd, 'tools', 'broken', '{ not valid json');
      writePlugin(f.cwd, 'tools', 'good', JSON.stringify({ minMemoryMb: 2048 }));
      const logs: string[] = [];
      const out = discoverPluginResources(join(f.cwd, '.nanogent'), (m) => { logs.push(m); });
      // Good one still parsed
      assert.equal(out.length, 1);
      assert.equal(out[0]?.name, 'good');
      // Warning emitted for the broken one
      assert.ok(logs.some(l => l.includes('tools/broken/resources.json') && l.includes('not valid JSON')));
    } finally { f.cleanup(); }
  });

  it('discoverPluginResources ignores non-numeric fields with a warning', () => {
    const f = setupResFixture();
    try {
      writePlugin(f.cwd, 'tools', 'weird', JSON.stringify({
        minMemoryMb: 'a lot', minCpus: -1,
      }));
      const logs: string[] = [];
      const out = discoverPluginResources(join(f.cwd, '.nanogent'), (m) => { logs.push(m); });
      assert.equal(out.length, 1);
      assert.equal(out[0]?.minMemoryMb, undefined);
      assert.equal(out[0]?.minCpus, undefined);
      assert.ok(logs.some(l => l.includes('minMemoryMb')));
      assert.ok(logs.some(l => l.includes('minCpus')));
    } finally { f.cleanup(); }
  });

  it('aggregatePluginResources takes max across plugins', () => {
    const agg = aggregatePluginResources([
      { root: 'tools', name: 'a', resourcesPath: 'tools/a/resources.json', minMemoryMb: 1024, minCpus: 1 },
      { root: 'tools', name: 'b', resourcesPath: 'tools/b/resources.json', minMemoryMb: 4096, minCpus: 0.5 },
      { root: 'tools', name: 'c', resourcesPath: 'tools/c/resources.json', minMemoryMb: 2048 },
    ]);
    assert.equal(agg.minMemoryMb, 4096);
    assert.equal(agg.minMemoryMbFrom, 'tools/b');
    assert.equal(agg.minCpus, 1);
    assert.equal(agg.minCpusFrom, 'tools/a');
  });

  it('aggregatePluginResources returns empty object when no plugin declared anything', () => {
    const agg = aggregatePluginResources([]);
    assert.equal(agg.minMemoryMb, undefined);
    assert.equal(agg.minCpus, undefined);
  });

  const BASE_DF = [
    'FROM node:24-slim',
    '# __NANOGENT_PLUGIN_INSTALLS__',
    'CMD ["node"]',
    '',
  ].join('\n');

  function seedNanogent(cwd: string): void {
    mkdirSync(join(cwd, '.nanogent'), { recursive: true });
    writeFileSync(join(cwd, '.nanogent/Dockerfile'), BASE_DF);
  }

  it('runBuild emits no advisory when no plugin shipped resources.json', () => {
    const f = setupResFixture();
    try {
      seedNanogent(f.cwd);
      const logs: string[] = [];
      const r = runBuild({ cwd: f.cwd, logger: (m) => { logs.push(m); } });
      assert.equal(r.resources.length, 0);
      assert.ok(!logs.some(l => l.includes('advisory:')));
    } finally { f.cleanup(); }
  });

  it('runBuild emits advisory with max memory and notes missing compose limits', () => {
    const f = setupResFixture();
    try {
      seedNanogent(f.cwd);
      // Compose file without any resource limits.
      writeFileSync(
        join(f.cwd, '.nanogent/docker-compose.yml'),
        'services:\n  nanogent:\n    build:\n      context: .\n',
      );
      writePlugin(f.cwd, 'tools', 'heavy', JSON.stringify({ minMemoryMb: 4096, note: 'LSP' }));
      writePlugin(f.cwd, 'tools', 'light', JSON.stringify({ minMemoryMb: 512 }));

      const logs: string[] = [];
      const r = runBuild({ cwd: f.cwd, logger: (m) => { logs.push(m); } });

      assert.equal(r.resources.length, 2);
      assert.ok(logs.some(l => l.includes('advisory:') && l.includes('2 plugins')));
      // Uses the max (4096), not the sum (4608)
      assert.ok(logs.some(l => l.includes('≥ 4096 MB memory') && l.includes('tools/heavy')));
      assert.ok(!logs.some(l => l.includes('4608')));
      // Notes missing compose limits
      assert.ok(logs.some(l => l.includes('no mem_limit/cpus set')));
      // Per-plugin note is surfaced
      assert.ok(logs.some(l => l.includes('LSP')));
    } finally { f.cleanup(); }
  });

  it('runBuild notes when compose already declares resource limits', () => {
    const f = setupResFixture();
    try {
      seedNanogent(f.cwd);
      writeFileSync(
        join(f.cwd, '.nanogent/docker-compose.yml'),
        'services:\n  nanogent:\n    build:\n      context: .\n    mem_limit: 2g\n',
      );
      writePlugin(f.cwd, 'tools', 'heavy', JSON.stringify({ minMemoryMb: 4096 }));

      const logs: string[] = [];
      runBuild({ cwd: f.cwd, logger: (m) => { logs.push(m); } });

      assert.ok(logs.some(l => l.includes('already declares resource limits')));
      assert.ok(!logs.some(l => l.includes('no mem_limit/cpus set')));
    } finally { f.cleanup(); }
  });

  it('runBuild with malformed resources.json still succeeds and warns', () => {
    const f = setupResFixture();
    try {
      seedNanogent(f.cwd);
      writePlugin(f.cwd, 'tools', 'broken', '{{{ not json');

      const logs: string[] = [];
      const r = runBuild({ cwd: f.cwd, logger: (m) => { logs.push(m); } });

      // Build still produced the Dockerfile
      assert.ok(existsSync(join(f.cwd, '.nanogent/Dockerfile.generated')));
      assert.equal(r.resources.length, 0);
      // Warning was logged, but no advisory block (no valid resources)
      assert.ok(logs.some(l => l.includes('tools/broken/resources.json') && l.includes('not valid JSON')));
      assert.ok(!logs.some(l => l.includes('advisory:')));
    } finally { f.cleanup(); }
  });
});

