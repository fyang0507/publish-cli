import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAuthProbeRegistry, unexpectedProbeReadiness } from "../auth/registry.js";

const cli = fileURLToPath(new URL("../cli.js", import.meta.url));

test("website info exposes an unprobed local agent handoff in both modes", () => {
  for (const mode of [[], ["--static"]]) {
    const result = JSON.parse(execFileSync(process.execPath, [cli, "website", "info", "--json", ...mode], { encoding: "utf8" }));
    assert.equal(result.channel, "website");
    if (mode.length) {
      assert.equal(result.readiness.state, "skipped");
      assert.equal(result.access.platformAccessAttempted, false);
    } else {
      assert.equal(result.readiness.ready, false);
      assert.equal(result.readiness.status, "agent_check_required");
      assert.equal(result.readiness.evidence.liveProbe, "not_run");
      assert.equal(result.readiness.verificationMode, "agent_workflow");
      assert.equal(result.readiness.nextStep.executor, "agent");
      assert.equal(result.readiness.nextStep.recoveryContext.venue, "local_runtime");
    }
  }
  const draft = spawnSync(process.execPath, [cli, "website", "draft"], { encoding: "utf8" });
  assert.notEqual(draft.status, 0);
});

test("website readiness and unexpected failures never route to browser login", async () => {
  const result = await createAuthProbeRegistry({
    now: () => 0,
    browserBackend: new Proxy({}, { get() { throw new Error("Browser access forbidden"); } }) as never,
  }).website();
  assert.equal(result.checkedAt, new Date(0).toISOString());
  assert.equal(result.ready, false);
  for (const error of [new Error("network timeout"), new Error("unexpected")]) {
    const failed = unexpectedProbeReadiness("website", error, 0);
    assert.equal(failed.ready, false);
    assert.equal(failed.verificationMode, "agent_workflow");
    assert.equal(failed.nextStep?.recoveryContext.venue, "local_runtime");
    assert.equal(failed.nextStep?.workflowRef, "publish website info --static");
    assert.equal(failed.nextStep?.entryUrl, undefined);
  }
});
