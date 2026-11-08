/**
 * Append the three Crew log-only events for SDK and persistence projections.
 * This fixture does not exercise Crew route selection, replacement, or budget enforcement.
 */
export const name = 'snapshot-crew-session-events'

/** @param {import('@deepseek-ai/cordis').Context} ctx - Scenario-owned runtime. */
export function apply(ctx) {
  ctx.on('agent/pre-step', ({ agent, turn, step }, next) => {
    if (agent.session.header.parentSession !== undefined || turn !== 1 || step !== 1) return next()
    agent.session.append('crew/routes-selected', {
      presetId: 'snapshot-routes',
      presetName: 'Snapshot routes',
      routes: {
        worker: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high' },
        planner: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
        reviewer: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
      },
    })
    agent.session.append('crew/route-replaced', {
      role: 'worker',
      route: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
    })
    agent.session.append('crew/run-budget-exceeded', {
      turn,
      reason: 'steps',
      limit: 300,
      observed: 300,
    })
    return next()
  })
}
