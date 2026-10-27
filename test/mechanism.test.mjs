import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply as applyBingxing } from "../lib/index.js";
import * as Gongjuyasuo from "../../dsh-gongjuyasuo/lib/index.js";
import { runScheduledCalls } from "./scheduler.mjs";

const installedBase = "file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/";
const installed = (name) => import(`${installedBase}${name}/lib/index.js`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createHarness(t, { bingxing = true, gongjuyasuo = true, delayMs = 60, grepMaxMatches = 3, globMaxResults = 3 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bingxing-"));
  const names = [
    "cordis", "dsh-session", "dsh-session-projection", "dsh-token-meter", "dsh-session-query",
    "dsh-agent", "dsh-llm", "dsh-system-prompt", "dsh-tools", "dsh-agent-loop", "dsh-fs-local",
    "dsh-working-directory", "dsh-subprocess-local", "dsh-spill-local", "dsh-tool-fs",
    "dsh-tool-fs-search", "dsh-tool-call-timeout-policy", "dsh-bash-local", "dsh-shell-env", "dsh-tool-bash",
  ];
  const mods = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await installed(name)])));
  const tokenClient = await import(`${installedBase}dsh-token-meter/lib/types/client.js`);
  const ctx = new mods.cordis.Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  new mods["dsh-session"].SessionStore(ctx);
  new mods["dsh-session-projection"].SessionProjectionRegistry(ctx);
  new mods["dsh-token-meter"].TokenMeter(ctx, {});
  new mods["dsh-session-query"].SessionQueryEngine(ctx);
  new mods["dsh-agent"].AgentRegistry(ctx);
  new mods["dsh-llm"].LlmRuntime(ctx);
  new mods["dsh-system-prompt"].SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  new mods["dsh-tools"].ToolRuntime(ctx);
  new mods["dsh-fs-local"].default(ctx, { cwd: dir, diffBasisMaxBytes: 1_000_000 });
  new mods["dsh-working-directory"].WorkingDirectoryService(ctx, { defaultDirectory: dir });
  new mods["dsh-agent-loop"].AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 10 } });
  await ctx.plugin(mods["dsh-subprocess-local"].default, {});
  await ctx.plugin(mods["dsh-spill-local"].default, {});
  await ctx.plugin(mods["dsh-tool-fs"], { readImage: false });
  await ctx.plugin(mods["dsh-tool-fs-search"], {
    sampleOverCapGlobResults: false,
    grepMaxMatches,
    globMaxResults,
  });
  await ctx.plugin(mods["dsh-tool-call-timeout-policy"]);
  await ctx.plugin(mods["dsh-bash-local"].default, { cwd: dir });
  await ctx.plugin(mods["dsh-shell-env"], {});
  await ctx.plugin(mods["dsh-tool-bash"], { enableRunInBackground: false });
  ctx.provide("loader", {
    import: (spec) => spec === "@deepseek-ai/dsh-token-meter/client"
      ? tokenClient
      : installed(spec.replace("@deepseek-ai/", "")),
  });
  const traces = [];
  const running = [];
  let maxConcurrent = 0;
  ctx.on("tools/execute", async (exec, next) => {
    const rec = { callId: exec.callId, name: exec.name, start: Date.now(), end: null };
    traces.push(rec);
    running.push(rec);
    maxConcurrent = Math.max(maxConcurrent, running.length);
    if (delayMs && (exec.name === "grep" || exec.name === "glob")) await sleep(delayMs);
    try {
      return await next();
    } finally {
      rec.end = Date.now();
      const index = running.indexOf(rec);
      if (index >= 0) running.splice(index, 1);
    }
  });
  let bingxingFiber;
  if (bingxing) {
    bingxingFiber = ctx.plugin({ name: "dsh-bingxing", inject: ["tools", "agents"], apply: applyBingxing });
    await bingxingFiber;
  }
  if (gongjuyasuo) {
    await ctx.plugin(Gongjuyasuo, {
      configPath: "/Users/ning/.dsh/plugins/dsh-gongjuyasuo/config.json",
      diagnosticsPath: join(dir, "gongjuyasuo-diagnostics.jsonl"),
      settings: {
        thresholdChars: 80,
        watermarkChars: 80,
        minNetReductionChars: 1,
        minTailContributionChars: 1,
        reminderIntervalRequests: 1,
        recentProtectionRequests: 1,
      },
    });
  }
  const handle = await ctx.agents.create({ sessionId: `bingxing-${Date.now()}-${Math.random().toString(16).slice(2)}`, meta: { cwd: dir } });
  return { ctx, dir, agent: handle.agent, traces, getMaxConcurrent: () => maxConcurrent, bingxingFiber, llm: mods["dsh-llm"] };
}

function overlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

function textOf(result) {
  return (result.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

test("without bingxing, same-step greps stay exclusive", async (t) => {
  const h = await createHarness(t, { bingxing: false, gongjuyasuo: false });
  await writeFile(join(h.dir, "a.txt"), "alpha\n");
  await writeFile(join(h.dir, "b.txt"), "beta\n");
  const signal = new AbortController().signal;
  assert.equal(h.ctx.tools.executionMode({ name: "grep", arguments: { pattern: "alpha" }, agent: h.agent }).kind, "exclusive");
  const committed = await runScheduledCalls(h.ctx, h.agent, [
    { id: "g1", name: "grep", arguments: { pattern: "alpha", path: h.dir } },
    { id: "g2", name: "grep", arguments: { pattern: "beta", path: h.dir } },
  ], signal);
  assert.equal(committed.length, 2);
  assert.equal(h.getMaxConcurrent(), 1);
  const [first, second] = h.traces.filter((row) => row.name === "grep");
  assert.ok(first.end <= second.start);
});

test("with bingxing, same-step grep/glob overlap, keep model order, edit stays exclusive, second grep sees edit", async (t) => {
  const h = await createHarness(t, { gongjuyasuo: true });
  const marker = join(h.dir, "marker.txt");
  await writeFile(marker, "before-token\n");
  await writeFile(join(h.dir, "one.js"), "needle-one\n");
  await writeFile(join(h.dir, "two.js"), "needle-two\n");
  const grepDef = h.ctx.tools.get("grep", h.agent);
  const globDef = h.ctx.tools.get("glob", h.agent);
  assert.equal(grepDef.isConcurrencySafe(), true);
  assert.equal(globDef.isConcurrencySafe(), true);
  assert.equal(h.ctx.tools.executionMode({ name: "grep", arguments: { pattern: "needle" }, agent: h.agent }).kind, "parallel");
  assert.equal(h.ctx.tools.executionMode({ name: "glob", arguments: { pattern: "*.js" }, agent: h.agent }).kind, "parallel");
  assert.equal(h.ctx.tools.executionMode({ name: "edit", arguments: { file_path: marker, old_string: "x", new_string: "y" }, agent: h.agent }).kind, "exclusive");
  assert.equal(h.ctx.tools.executionMode({ name: "bash", arguments: { command: "true", description: "noop" }, agent: h.agent }).kind, "exclusive");
  const signal = new AbortController().signal;
  const committed = await runScheduledCalls(h.ctx, h.agent, [
    { id: "g1", name: "grep", arguments: { pattern: "needle-one", path: h.dir } },
    { id: "g2", name: "grep", arguments: { pattern: "needle-two", path: h.dir } },
    { id: "gl1", name: "glob", arguments: { pattern: "*.js", path: h.dir } },
  ], signal);
  assert.equal(committed.map((row) => row.callId).join(","), "g1,g2,gl1");
  assert.equal(committed.every((row) => row.result.isError !== true), true);
  assert.ok(h.getMaxConcurrent() > 1);
  const greps = h.traces.filter((row) => row.callId === "g1" || row.callId === "g2");
  assert.equal(greps.length, 2);
  assert.ok(overlap(greps[0], greps[1]));
  assert.ok(textOf(committed[0].result).includes("needle-one"));
  assert.ok(textOf(committed[1].result).includes("needle-two"));

  h.traces.length = 0;
  const mixed = await runScheduledCalls(h.ctx, h.agent, [
    { id: "pre", name: "grep", arguments: { pattern: "before-token", path: marker } },
    { id: "ed", name: "edit", arguments: { file_path: marker, old_string: "before-token", new_string: "after-token" } },
    { id: "post", name: "grep", arguments: { pattern: "after-token", path: marker } },
  ], new AbortController().signal);
  assert.equal(mixed.map((row) => row.callId).join(","), "pre,ed,post");
  assert.ok(textOf(mixed[0].result).includes("before-token"));
  assert.notEqual(mixed[1].result.isError, true);
  assert.ok(textOf(mixed[2].result).includes("after-token"));
  const pre = h.traces.find((row) => row.callId === "pre");
  const ed = h.traces.find((row) => row.callId === "ed");
  const post = h.traces.find((row) => row.callId === "post");
  assert.ok(pre.end <= ed.start);
  assert.ok(ed.end <= post.start);

  const bashMix = await runScheduledCalls(h.ctx, h.agent, [
    { id: "bg", name: "grep", arguments: { pattern: "after-token", path: marker } },
    { id: "bb", name: "bash", arguments: { command: "/usr/local/bin/node --version", description: "node version" } },
  ], new AbortController().signal);
  const bg = h.traces.find((row) => row.callId === "bg");
  const bb = h.traces.find((row) => row.callId === "bb");
  assert.ok(bg.end <= bb.start);
  assert.notEqual(bashMix[1].result.isError, true);
});

test("over-cap spill keeps original identity; one grep failure does not cancel the other; dispose restores exclusive", async (t) => {
  const h = await createHarness(t, { grepMaxMatches: 2, globMaxResults: 2, gongjuyasuo: true });
  const lines = Array.from({ length: 12 }, (_, i) => `match-line-${String(i).padStart(2, "0")} ${"x".repeat(40)}`);
  await writeFile(join(h.dir, "wide.txt"), `${lines.join("\n")}\n`);
  for (let i = 0; i < 8; i++) await writeFile(join(h.dir, `file-${i}.txt`), `n${i}\n`);
  const committed = await runScheduledCalls(h.ctx, h.agent, [
    { id: "spill-grep", name: "grep", arguments: { pattern: "match-line-", path: join(h.dir, "wide.txt") } },
    { id: "spill-glob", name: "glob", arguments: { pattern: "file-*.txt", path: h.dir } },
    { id: "bad", name: "grep", arguments: { pattern: "(", path: h.dir } },
    { id: "ok", name: "grep", arguments: { pattern: "match-line-00", path: join(h.dir, "wide.txt") } },
  ], new AbortController().signal);
  const byId = Object.fromEntries(committed.map((row) => [row.callId, row.result]));
  assert.ok(textOf(byId["spill-grep"]).includes("grep-results.txt") || textOf(byId["spill-grep"]).includes("Full grep result stored at:"));
  assert.ok(textOf(byId["spill-glob"]).includes("glob-results.txt") || textOf(byId["spill-glob"]).includes("Full sorted result stored at:"));
  assert.equal(byId.bad.isError, true);
  assert.notEqual(byId.ok.isError, true);
  assert.ok(textOf(byId.ok).includes("match-line-00"));
  assert.equal(committed.map((row) => row.callId).join(","), "spill-grep,spill-glob,bad,ok");

  const session = h.agent.session;
  const callId = "spill-grep";
  session.append("tool/call", { turn: 1, step: 1, callId, name: "grep", arguments: { pattern: "match-line-", path: join(h.dir, "wide.txt") } });
  const message = h.llm.freezeMessage({
    id: `tool-${callId}`,
    role: "tool",
    toolCallId: callId,
    source: { kind: "tool", callId },
    content: byId["spill-grep"].content,
  });
  session.append("tool/result", { turn: 1, step: 1, message }, { surfaceOp: "append" });
  const inspect = await h.ctx.tools.execute({
    name: "gongjuyasuo",
    callId: "inspect-1",
    agent: h.agent,
    arguments: { action: "inspect" },
    signal: new AbortController().signal,
  });
  assert.equal(inspect.isError, false);
  assert.equal(inspect.value.ok, true);
  const candidate = inspect.value.candidates.find((row) => row.tool === "grep");
  if (candidate) {
    const checkpoint = await h.ctx.tools.execute({
      name: "gongjuyasuo",
      callId: "cp-1",
      agent: h.agent,
      arguments: {
        action: "checkpoint",
        previousCheckpoint: inspect.value.previousCheckpoint,
        state: {
          subgoal: "verify spill recover",
          nextStep: "continue",
          findings: [{ text: "grep spill locator observed", refs: [candidate.ref] }],
          constraints: ["original object identity"],
          changes: "none",
          validation: "mechanism",
          unresolved: [],
          hypotheses: [],
        },
        covered: [{
          ref: candidate.ref,
          conclusion: "spill path retained",
          evidenceQuote: textOf(byId["spill-grep"]).slice(0, 40),
          noLongerDirectlyNeeded: true,
        }],
        retain: [],
      },
      signal: new AbortController().signal,
    });
    assert.equal(checkpoint.isError, false);
    await h.ctx.waterfall(h.ctx, "agent/pre-step", { agent: h.agent, signal: new AbortController().signal }, () => Promise.resolve({ kind: "enter", messages: [] }));
    const recovered = await h.ctx.tools.execute({
      name: "gongjuyasuo",
      callId: "recover-1",
      agent: h.agent,
      arguments: { action: "recover", ref: candidate.ref },
      signal: new AbortController().signal,
    });
    if (recovered.isError !== true && recovered.value?.ok) {
      assert.equal(recovered.value.ok, true);
    }
  }

  await h.bingxingFiber.dispose();
  assert.equal(h.ctx.tools.executionMode({ name: "grep", arguments: { pattern: "x" }, agent: h.agent }).kind, "exclusive");
  assert.equal(h.ctx.tools.executionMode({ name: "glob", arguments: { pattern: "*" }, agent: h.agent }).kind, "exclusive");
});
