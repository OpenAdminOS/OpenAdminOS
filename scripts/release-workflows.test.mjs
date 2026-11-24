import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { load as parseYaml } from "js-yaml";

const autoTag = parseYaml(readFileSync(".github/workflows/auto-tag.yml", "utf8"));
const release = parseYaml(readFileSync(".github/workflows/release.yml", "utf8"));
const decision = autoTag.jobs.tag.steps.find((step) => step.id === "decision").run;
const resolveChannel = release.jobs.meta.steps.find((step) => step.id === "resolve").run;
const validateBackfill = release.jobs["backfill-apt-repository"].steps.find(
  (step) => step.name === "Validate backfill tag",
).run;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "release-workflows-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  for (const script of ["decide-release.sh", "nightly-app-changes.sh", "release-version.mjs"]) {
    copyFileSync(`scripts/${script}`, join(repo, "scripts", script));
  }
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", repo);

  const commit = (path, contents) => {
    const file = join(repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    git("add", "--", path);
    git("commit", "-qm", `Update ${path}`);
  };
  const run = (script, env) => {
    const output = join(root, "output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", script], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: output, ...env },
    });
    const outputs = Object.fromEntries(
      readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("=")),
    );
    return { ...result, outputs };
  };
  return { git, commit, run };
}

test("approval selects stable while unapproved or tagged versions still evaluate app changes", (t) => {
  const { git, commit, run } = fixture(t);
  commit("package.json", '{"version":"0.7.2"}');
  git("tag", "v0.7.2");
  commit("apps/desktop/app.ts", "previous nightly");
  git("tag", "v0.7.3-nightly.20261124103910");
  commit("package.json", '{"version":"0.8.0"}');
  commit("apps/desktop/app.ts", "next nightly");

  const decide = (approval) => {
    const result = run(decision, { STABLE_RELEASE_APPROVED: approval });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.version, "0.8.0");
    return result;
  };
  for (const approval of ["", "0.7.2", "v0.8.0", "0.8.0 "]) {
    const result = decide(approval);
    assert.equal(result.outputs.channel, "nightly");
    assert.ok(result.stdout.includes(
      "::notice::Stable 0.8.0 is waiting for approval: set the STABLE_RELEASE_APPROVED repository variable to 0.8.0",
    ));
  }

  const sha = git("rev-parse", "HEAD");
  const nightly = run(resolveChannel, {
    NIGHTLY_SHA: sha,
    REF: "refs/heads/main",
    STABLE_RELEASE_APPROVED: "",
  });
  assert.equal(nightly.status, 0, nightly.stderr);
  assert.equal(nightly.outputs.channel, "nightly");
  assert.match(nightly.outputs.version, /^0\.8\.0-nightly\.2\d{13}$/);
  assert.equal(nightly.outputs.tag, `v${nightly.outputs.version}`);
  assert.equal(nightly.outputs.sha, sha);
  assert.equal(decide("0.8.0").outputs.channel, "stable");

  git("tag", nightly.outputs.tag);
  commit("README.md", "docs only");
  assert.equal(decide("").outputs.channel, "none");
  git("tag", "v0.8.0");
  commit(
    "scripts/decide-release.sh",
    `${readFileSync("scripts/decide-release.sh", "utf8")}\n# Release decision tooling only\n`,
  );
  assert.equal(decide("0.8.0").outputs.channel, "none");
  commit("apps/desktop/app.ts", "app change after stable");
  assert.equal(decide("0.8.0").outputs.channel, "nightly");
});

test("release metadata blocks unapproved and manually dispatched stable tags", (t) => {
  assert.ok(Object.hasOwn(autoTag.on, "workflow_dispatch"));
  assert.deepEqual(Object.keys(release.on), ["workflow_dispatch"]);
  const { git, commit, run } = fixture(t);
  commit("package.json", '{"version":"0.8.0"}');
  const sha = git("rev-parse", "HEAD");
  const resolveStable = (approval, actor, tag = "v0.8.0") => run(resolveChannel, {
    NIGHTLY_SHA: "",
    REF: `refs/tags/${tag}`,
    REF_NAME: tag,
    SHA: sha,
    RELEASE_ACTOR: actor,
    STABLE_RELEASE_APPROVED: approval,
  });
  for (const approval of ["", "0.7.2"]) {
    const result = resolveStable(approval, "github-actions[bot]");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Stable 0\.8\.0 requires STABLE_RELEASE_APPROVED to equal 0\.8\.0/);
    assert.equal(result.outputs.channel, undefined);
  }
  const manual = resolveStable("0.8.0", "maintainer");
  assert.equal(manual.status, 1);
  assert.match(manual.stderr, /Stable releases must be dispatched by Auto-tag release versions/);
  const wrongTag = resolveStable("0.8.0", "github-actions[bot]", "v0.7.2");
  assert.equal(wrongTag.status, 1);
  assert.match(wrongTag.stderr, /must match package.json version/);

  const stable = resolveStable("0.8.0", "github-actions[bot]");
  assert.equal(stable.status, 0, stable.stderr);
  assert.deepEqual(stable.outputs, { channel: "stable", version: "0.8.0", tag: "v0.8.0", sha });
});

test("manual apt backfill requires an already published stable release", (t) => {
  const { run } = fixture(t);
  const check = (publishedStable) => run(`
    gh() { printf '%s\n' "$PUBLISHED_STABLE"; }
    ${validateBackfill}
  `, {
    BACKFILL_TAG: "v0.7.2",
    NIGHTLY_SHA: "",
    PUBLISHED_STABLE: publishedStable,
    STABLE_RELEASE_APPROVED: "",
  });
  assert.equal(check("true").status, 0);

  const unpublished = check("false");
  assert.equal(unpublished.status, 1);
  assert.match(unpublished.stdout, /only published stable releases go into the apt repository/);
});
