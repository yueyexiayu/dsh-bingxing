export const name = "dsh-bingxing";
export const inject = ["tools", "agents"];
export const VERSION = "0.1.0";
export const TOOL_NAMES = ["grep", "glob"];

const ABSENT = Symbol("dsh-bingxing.absent");

function concurrencySafe() {
  return true;
}

function markOriginal(tool, toolName, restorers, seen) {
  if (tool == null || typeof tool !== "object") {
    throw new Error(`dsh-bingxing: tool "${toolName}" is not a definition object`);
  }
  if (Object.isFrozen(tool)) {
    throw new Error(`dsh-bingxing: tool "${toolName}" definition is frozen`);
  }
  if (seen.has(tool)) return;
  seen.add(tool);
  const previous = Object.hasOwn(tool, "isConcurrencySafe") ? tool.isConcurrencySafe : ABSENT;
  tool.isConcurrencySafe = concurrencySafe;
  restorers.push(() => {
    if (previous === ABSENT) delete tool.isConcurrencySafe;
    else tool.isConcurrencySafe = previous;
  });
}

function patchScope(ctx, scope, restorers, seen) {
  const missing = [];
  for (const toolName of TOOL_NAMES) {
    const tool = ctx.tools.get(toolName, scope);
    if (!tool) missing.push(toolName);
    else markOriginal(tool, toolName, restorers, seen);
  }
  return missing;
}

export function apply(ctx) {
  const restorers = [];
  const seen = new WeakSet();
  const patch = (scope) => patchScope(ctx, scope, restorers, seen);
  const globalMissing = patch(undefined);
  if (globalMissing.length !== 0) {
    const patchAgent = (agent) => {
      const missing = patch(agent);
      if (missing.length > 0) {
        throw new Error(`dsh-bingxing: ${missing.join(", ")} not registered for this agent`);
      }
    };
    for (const agent of ctx.agents.list()) patchAgent(agent);
    ctx.on("agent/created", ({ agent }) => {
      patchAgent(agent);
    }, { global: true });
  }
  ctx.effect(() => () => {
    for (const restore of restorers.splice(0).reverse()) restore();
  }, "dsh-bingxing.restore");
}
