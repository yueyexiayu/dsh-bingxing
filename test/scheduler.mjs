import { TOOL_RUNTIME_SCHEDULER } from "file:///Applications/DeepSeek%20Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js";

function assertNever(value, label) {
  throw new Error(`tool-call scheduler: unexpected ${label}: ${value}`);
}

/**
 * Faithful replica of 0.2.1-alpha.4 agent-loop executeToolCalls + runGroup
 * against the exported TOOL_RUNTIME_SCHEDULER. Used only in mechanism tests.
 */
export async function runScheduledCalls(ctx, agent, toolCalls, signal, maxParallelToolCalls = 10) {
  const planned = toolCalls.map((block) => ({
    block,
    exec: {
      callId: block.id,
      name: block.name,
      arguments: block.arguments,
      agent,
      signal,
    },
  }));
  const committed = [];
  let next = 0;
  while (next < planned.length) {
    const first = planned[next];
    const mode = ctx.tools.executionMode(first.exec).kind;
    const group = mode === "parallel" ? planned.slice(next) : [first];
    const outcome = await runGroup(ctx, group, mode, signal, maxParallelToolCalls, committed);
    next += outcome.consumed;
    if (outcome.aborted) break;
  }
  return committed;
}

async function runGroup(ctx, group, mode, signal, maxParallelToolCalls, committed) {
  const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER];
  const slots = group.map(() => undefined);
  let nextToStart = 0;
  let committedCount = 0;
  let started = 0;
  let aborted = signal.aborted;
  let schedulerFailure;
  const throwSchedulerFailure = () => {
    if (schedulerFailure !== undefined) throw schedulerFailure.error;
  };
  const commitReady = async () => {
    while (committedCount < group.length) {
      const slot = slots[committedCount];
      if (slot === undefined) break;
      const result = slot.needsPost
        ? await scheduler.finalize(slot.exec, slot.result)
        : scheduler.finish(slot.exec, slot.result);
      committed.push({
        name: group[committedCount].block.name,
        callId: group[committedCount].block.id,
        result,
      });
      committedCount++;
    }
  };
  const inFlight = new Map();
  const startCall = async (index) => {
    started++;
    const prepared = await scheduler.prepare(group[index].exec);
    throwSchedulerFailure();
    switch (prepared.kind) {
      case "dispatch": {
        const promise = scheduler.dispatch(prepared.exec).then((outcome) => {
          slots[index] = {
            exec: prepared.exec,
            result: outcome.result,
            needsPost: outcome.kind === "post-result",
          };
          return index;
        }, (error) => {
          schedulerFailure ??= { error };
          return index;
        });
        inFlight.set(index, promise);
        break;
      }
      case "post-result":
        slots[index] = {
          exec: prepared.exec,
          result: prepared.result,
          needsPost: true,
        };
        break;
      case "final-result":
        slots[index] = {
          exec: prepared.exec,
          result: prepared.result,
          needsPost: false,
        };
        break;
      default:
        assertNever(prepared.kind, "prepare result");
    }
  };
  const fillPool = async () => {
    while (!aborted && nextToStart < group.length && inFlight.size < maxParallelToolCalls) {
      const nextCall = group[nextToStart];
      if (nextToStart > 0 && mode === "parallel" && ctx.tools.executionMode(nextCall.exec).kind !== "parallel") break;
      await startCall(nextToStart);
      nextToStart++;
      throwSchedulerFailure();
      await commitReady();
      throwSchedulerFailure();
      if (signal.aborted) aborted = true;
    }
  };
  try {
    await fillPool();
    while (inFlight.size > 0) {
      const settledIndex = await Promise.race(inFlight.values());
      inFlight.delete(settledIndex);
      throwSchedulerFailure();
      await commitReady();
      throwSchedulerFailure();
      if (signal.aborted) aborted = true;
      await fillPool();
    }
  } catch (error) {
    schedulerFailure ??= { error };
    await Promise.allSettled(inFlight.values());
    throw schedulerFailure.error;
  }
  return {
    consumed: aborted ? group.length : started,
    aborted,
  };
}
