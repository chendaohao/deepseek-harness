# Delegation route settings become namespace-declared

`@deepseek-ai/dsh-tool-subagent` no longer takes the `workerRouteSettings: true` boolean. A delegation row now names the settings namespace it follows with `routeSettingsNamespace`, and the namespace is served by a composed `subagent-*-route-settings` row whose Loader entry id equals its `config.namespace`. Three roles can now compose side by side — `subagent-worker-route-settings`, `subagent-planner-route-settings`, and `subagent-reviewer-route-settings` — each publishing its owner into one shared registry instead of every row claiming the same service name.

## 1. Who is affected

Deployments that mount a delegation tool with `workerRouteSettings: true`, and deployments that mount the `worker-route-settings` plugin directly. Deployments without either are unaffected.

## 2. What to change

1. In the delegation tool row, replace `workerRouteSettings: true` with `routeSettingsNamespace: <namespace>`.
2. In the settings row, add `namespace: <entry-id>`. The entry id and the namespace must be equal; `verify-cordis-config` fails the composition when they diverge.
3. Mount the shared registry once, before any settings row: `- id: subagent-route-settings-registry` with `name: '@deepseek-ai/dsh-tool-subagent/route-settings-registry'`. Every settings row injects `subagentRouteSettings`; without this row a settings row stays pending and its route silently disappears.
4. Give every settings row its own `isolate` realm for the per-row service name so same-named rows compose: `isolate: { subagentWorkerRoute: true }`. Consumers reach rows through the registry, not through that service name.
5. For a planner or reviewer role, add a matching `subagent-planner-route-settings` / `subagent-reviewer-route-settings` row and declare the same namespace on the delegation row that serves that role. A child's durable `subagent/worker-route` marker names the namespace, so installs stay exact: a worker-row listener never routes a planner child to the worker route.

## 3. What stays true

The stored route shape (`provider`, `model`, `reasoningEffort`), the Models-page worker-route block, and the durable `subagent/worker-route` marker keep their meaning. Existing children whose marker names the worker namespace keep re-resolving from that namespace's setting.
