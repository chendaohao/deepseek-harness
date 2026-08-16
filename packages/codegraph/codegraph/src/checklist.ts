/**
 * Canonical CodeGraph checklist text injected into sessions whose workspace
 * carries a `.codegraph/` index. Keep the `<!-- CODEGRAPH_START -->` /
 * `<!-- CODEGRAPH_END -->` markers so codegraph's own installer tooling can
 * recognize and strip the block.
 *
 * @module @deepseek-ai/dsh-codegraph/checklist
 */

/** Checklist body between the CODEGRAPH markers (shared by the injected frame). */
export const CODEGRAPH_CHECKLIST_BODY: string = [
  '## CodeGraph',
  '',
  '**【强制检查清单】在 Read/grep/Bash 或委托子代理前，依次执行：**',
  '1. `test -d .codegraph/` — 确认索引存在（本工作区已检测到 `.codegraph/`，但嵌套子项目可能有各自的索引）',
  '2. 若存在 → 先检查本会话工具目录中是否有 `mcp__codegraph__*` 工具（本插件在首个回合异步启动 codegraph MCP server；启动失败时这些工具不会出现，本会话内不会重试）：',
  '   - 有 → 优先使用它们。**每次调用都传 `projectPath: <当前工作区绝对路径>`**（DSH 的 MCP 连接不带 rootUri、服务端无默认项目；传了 projectPath 即可打开任意已索引项目）；首选 `mcp__codegraph__codegraph_explore`（查结构/调用链/影响面，一次调用返回源码+路径），需要深度时用 `mcp__codegraph__codegraph_node`，全文检索用 `mcp__codegraph__codegraph_search`',
  '   - 没有 → 直接用第 3 步的 shell fallback，不要等待 MCP 重连',
  '3. 若 MCP 工具不可用或返回被截断 → 换更具体的 query 重试，或用 shell fallback `codegraph explore \\\\"<符号或问题>\\\\"`，不要直接跳到 grep/Read',
  '4. 委托 explore/reviewer 子代理时 → 把上述 1-3 复制到它的 prompt 开头（子代理不继承本指令，需主代理显式写入）',
  '',
  'Before using `grep`, `find`, or bulk `Read` to understand or locate code, first determine whether a CodeGraph index exists.',
  '',
  '### 1. Check for the index',
  '',
  'Look for a `.codegraph/` directory at the project root (or at the relevant sub-project root in a monorepo).',
  '',
  '### 2. If `.codegraph/` exists, use CodeGraph FIRST',
  '',
  'For any question about code location, structure, call paths, or impact scope:',
  '',
  '- **If this session\'s tool catalog has `mcp__codegraph__*`** — the plugin starts the codegraph MCP server asynchronously on the first indexed pre-step; when that startup fails the tools never appear in this session:',
  '  - `mcp__codegraph__codegraph_explore` — returns verbatim source, call paths, and blast radius in one call. Name the symbol or file in the query.',
  '  - `mcp__codegraph__codegraph_node` / `mcp__codegraph__codegraph_search` — depth lookup / full-text search.',
  '  - **Always pass `projectPath`** = the current workspace\'s absolute path.',
  '- **Shell fallback**: `codegraph explore \\\\"<symbol names or question>\\\\"` — do not wait for or retry the MCP connection.',
  '',
  'Only fall back to `Read` / `Bash` / `grep` when you need:',
  '',
  '- Complete file contents (codegraph returns excerpts)',
  '- Command execution (tests, lint, audit, secret scans)',
  '- External information (docs, CVEs, dependency versions)',
  '',
  '### 3. If `.codegraph/` does not exist',
  '',
  'Skip CodeGraph entirely and use `Read` / `Bash` / `grep` as needed. Indexing is the user\'s decision.',
  '',
  '### Subagent convention',
  '',
  'When delegating `code-reviewer`, `security-reviewer`, `critic`, `explore`, or similar subagents for code review or architecture work, prepend the same `.codegraph/`-first discipline to their prompt. Their final report should note which findings came from codegraph vs `Read` / `Bash` / `grep`.',
].join('\n')

/**
 * The complete model-facing frame: an opening system-reminder with the
 * workspace fact, the checklist between the CODEGRAPH markers, and the
 * closing tag. The session surface projects this verbatim.
 * @returns the framed checklist text.
 */
export function codegraphChecklistFrame(): string {
  return [
    '<system-reminder>',
    'A `.codegraph/` index exists for this workspace. Follow the CodeGraph checklist below before reaching for Read/grep on code questions.',
    '',
    '<!-- CODEGRAPH_START -->',
    CODEGRAPH_CHECKLIST_BODY,
    '<!-- CODEGRAPH_END -->',
    '</system-reminder>',
  ].join('\n')
}
