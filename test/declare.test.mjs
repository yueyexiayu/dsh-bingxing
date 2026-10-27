import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

const installedBase = "file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/";
const installed = (name) => import(`${installedBase}${name}/lib/index.js`);

function fakeCtx({ grep, glob, agents = [], created } = {}) {
  const listeners = [];
  const effects = [];
  const ctx = {
    tools: {
      get(name, scope) {
        if (!scope) return undefined;
        if (name === "grep") return grep;
        if (name === "glob") return glob;
      },
    },
    agents: { list: () => agents },
    on(event, fn) {
      listeners.push({ event, fn });
      return () => {};
    },
    effect(factory) {
      const dispose = factory();
      effects.push(dispose);
      return dispose;
    },
    dispose() {
      for (const dispose of effects.reverse()) if (typeof dispose === "function") dispose();
    },
    created(agent) {
      for (const listener of listeners) if (listener.event === "agent/created") listener.fn({ agent });
    },
  };
  if (created) agents.push(created);
  return ctx;
}

test("agent-created path marks the original grep/glob objects and restores them", () => {
  const grep = { name: "grep" };
  const glob = { name: "glob" };
  const ctx = fakeCtx({ grep, glob });
  apply(ctx);
  assert.equal(grep.isConcurrencySafe, undefined);
  ctx.created({ id: "agent-1" });
  assert.equal(grep.isConcurrencySafe(), true);
  assert.equal(glob.isConcurrencySafe(), true);
  const grepRef = grep;
  ctx.created({ id: "agent-2" });
  assert.equal(grep, grepRef);
  ctx.dispose();
  assert.equal(Object.hasOwn(grep, "isConcurrencySafe"), false);
  assert.equal(Object.hasOwn(glob, "isConcurrencySafe"), false);
});

test("frozen original definition is a visible failure", () => {
  const grep = Object.freeze({ name: "grep" });
  const glob = { name: "glob" };
  const ctx = fakeCtx({ grep, glob });
  apply(ctx);
  assert.throws(() => ctx.created({ id: "agent-1" }), /frozen/);
});

test("real ToolRuntime: mutate original object, executionMode parallel, same-name register fails, dispose restores exclusive", async () => {
  const [{ Context }, { ToolRuntime }, { SystemPrompt }] = await Promise.all([
    installed("cordis"),
    installed("dsh-tools"),
    installed("dsh-system-prompt"),
  ]);
  const ctx = new Context();
  new SystemPrompt(ctx, { includeHarnessIdentity: false, includeRuntimeContext: false });
  new ToolRuntime(ctx);
  const grep = {
    name: "grep",
    description: "test grep",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    output: {
      schema: { type: "object" },
      render: () => [{ type: "text", text: "ok" }],
    },
    async execute() {
      return { ok: true };
    },
  };
  const glob = {
    name: "glob",
    description: "test glob",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    output: {
      schema: { type: "object" },
      render: () => [{ type: "text", text: "ok" }],
    },
    async execute() {
      return { ok: true };
    },
  };
  ctx.tools.register(grep);
  ctx.tools.register(glob);
  assert.equal(ctx.tools.get("grep"), grep);
  assert.equal(ctx.tools.executionMode({ name: "grep", arguments: {} }).kind, "exclusive");
  assert.throws(
    () => ctx.tools.register({
      name: "grep",
      description: "dup",
      parameters: { type: "object", properties: {} },
      output: { schema: { type: "object" }, render: () => [{ type: "text", text: "x" }] },
      async execute() { return {}; },
    }),
    /already registered/,
  );
  const live = [];
  ctx.provide("agents", { list: () => live });
  const fiber = ctx.plugin({ name: "dsh-bingxing", inject: ["tools", "agents"], apply });
  await fiber;
  assert.equal(ctx.tools.get("grep"), grep);
  assert.equal(ctx.tools.executionMode({ name: "grep", arguments: {} }).kind, "parallel");
  assert.equal(ctx.tools.executionMode({ name: "glob", arguments: {} }).kind, "parallel");
  assert.equal(grep.isConcurrencySafe(), true);
  await fiber.dispose();
  assert.equal(Object.hasOwn(grep, "isConcurrencySafe"), false);
  assert.equal(ctx.tools.executionMode({ name: "grep", arguments: {} }).kind, "exclusive");
});
