// Exercise the installed Host's native scheduler rather than a private API.
export async function runScheduledCalls(ctx, agent, toolCalls, signal, maxParallelToolCalls = 10) {
  const batch = await ctx.tools.execute({
    calls: toolCalls.map((call) => ({
      type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.arguments),
    })),
    agent, signal, maxParallelToolCalls,
  });
  return batch.results.map((item, index) => ({ ...item, name: toolCalls[index].name }));
}
