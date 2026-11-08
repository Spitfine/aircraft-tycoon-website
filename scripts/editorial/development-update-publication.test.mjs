import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import matter from "gray-matter";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const contract = "scripts/editorial/development-update-contract.mjs";
const workflow = readFileSync(join(root, ".github/workflows/pages-cms-prepare-development-update-publication.yml"), "utf8");
const stageStep = workflow.split("- name: Stage only manifested paths")[1].split("- name: Commit publication candidate")[0];
// Execute the actual workflow guard so a regression in its Git flags fails this test.
const guardMatch = stageStep.match(/<<'NODE'\r?\n([\s\S]*?)\r?\n          NODE/);
assert.ok(guardMatch, "Publication workflow must expose its staged-path guard");
const guard = guardMatch[1].replace(/^          /gm, "");

function fixture(shared = false) {
  // Nested under the repository only to resolve its installed Node dependencies.
  const cwd = mkdtempSync(join(root, ".cms-test-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const write = (path, value) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), value);
  };
  const cleanup = () => {
    assert.equal(dirname(cwd), root);
    assert.ok(cwd.startsWith(join(root, ".cms-test-")));
    rmSync(cwd, { recursive: true });
  };
  try {
    mkdirSync(join(cwd, "scripts/editorial"), { recursive: true });
    copyFileSync(join(root, contract), join(cwd, contract));
    mkdirSync(join(cwd, "content/development-updates"), { recursive: true });
    mkdirSync(join(cwd, "assets/updates"), { recursive: true });
    const bilingual = { en: "Editorial test", pt: "Teste editorial" };
    const media = ["airframe.png", "propulsion.png", "portfolio.png"];
    const imageUrl = (name) => `/__draft-media/development-updates/${name}`;
    const draft = {
      update: {
        title: bilingual, category: "Aircraft Design", description: "Test description",
        socialDescription: "Test social description", deck: bilingual,
        surfaces: { archive: { excerpt: bilingual }, homepage: { excerpt: bilingual } },
        cover: { src: imageUrl(media[0]), alt: "Test cover" }
      },
      sections: [
        { type: "prose", body: bilingual },
        ...media.map((name) => ({ type: "image", image: { src: imageUrl(name), alt: bilingual } }))
      ]
    };
    const draftPath = "editorial-drafts/development-updates/test.md";
    write(draftPath, matter.stringify("", draft));
    for (const name of media) write(`editorial-drafts/media/development-updates/${name}`, Buffer.from(`unique image bytes: ${name}`));
    if (shared) write("editorial-drafts/development-updates/other.md", matter.stringify("", {
      update: { title: { en: "Another draft" }, cover: { src: imageUrl(media[0]) } }, sections: []
    }));
    git("init", "-q");
    git("config", "core.autocrlf", "false");
    git("config", "diff.renames", "true");
    git("add", ".");
    git("-c", "user.name=CMS test", "-c", "user.email=cms-test@example.invalid", "commit", "-qm", "Fixture baseline");
    const result = JSON.parse(execFileSync(process.execPath, [contract, "prepare-publish", "--draft", draftPath, "--publication-date", "2026-11-08"], { cwd, encoding: "utf8" }));
    assert.equal(result.validationStatus, "PASS");
    const manifest = join(cwd, ".git/publication-paths.nul");
    writeFileSync(manifest, `${result.changedPaths.join("\0")}\0`);
    git("add", `--pathspec-from-file=${manifest}`, "--pathspec-file-nul");
    const runGuard = () => spawnSync(process.execPath, ["--input-type=module", "-", manifest], { cwd, input: guard, encoding: "utf8" });
    return { cwd, git, result, runGuard, write, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

test("publication accepts three image renames and preserves exact bytes", () => {
  const f = fixture();
  try {
    assert.equal(f.git("diff", "--cached", "--name-status").split("\n").filter((line) => line.startsWith("R100")).length, 3);
    assert.equal(f.result.changedPaths.length, 8);
    const checked = f.runGuard();
    assert.equal(checked.status, 0, checked.stderr);
    for (const mapping of f.result.mediaMappings) {
      assert.equal(existsSync(join(f.cwd, mapping.source)), false);
      const original = execFileSync("git", ["show", `HEAD:${mapping.source}`], { cwd: f.cwd });
      assert.deepEqual(readFileSync(join(f.cwd, mapping.destination)), original);
    }
  } finally { f.cleanup(); }
});

test("generated publication passes Git whitespace validation", () => {
  const f = fixture();
  try { assert.doesNotThrow(() => f.git("diff", "--cached", "--check")); }
  finally { f.cleanup(); }
});

test("manifest guard rejects unrelated and missing staged paths", () => {
  const f = fixture();
  try {
    f.write("unrelated.txt", "Unrelated change\n");
    f.git("add", "--", "unrelated.txt");
    assert.match(f.runGuard().stderr, /Staged paths differ/);
    f.git("reset", "-q", "HEAD", "--", "unrelated.txt", f.result.targetMarkdownPath);
    assert.match(f.runGuard().stderr, /Staged paths differ/);
  } finally { f.cleanup(); }
});

test("images shared with another draft remain available to that draft", () => {
  const f = fixture(true);
  try {
    const shared = f.result.mediaMappings.find((mapping) => mapping.source.endsWith("/airframe.png"));
    assert.equal(shared.draftSourceRemoved, false);
    assert.equal(existsSync(join(f.cwd, shared.source)), true);
    assert.deepEqual(readFileSync(join(f.cwd, shared.source)), readFileSync(join(f.cwd, shared.destination)));
    const checked = f.runGuard();
    assert.equal(checked.status, 0, checked.stderr);
  } finally { f.cleanup(); }
});
