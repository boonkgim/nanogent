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
  composeDockerfile, discoverPluginInstalls, runBuild, runUpdate,
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

