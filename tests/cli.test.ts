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

import { runUpdate } from '../bin/cli.ts';

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
