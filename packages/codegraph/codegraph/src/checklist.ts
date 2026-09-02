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
  '**CodeGraph 优先原则**',
  '',
  '1. 当前工作区存在 `.codegraph/` 时，优先使用 CodeGraph 定位代码、调用链或影响面：',
  '   - 有 `mcp__codegraph__*` 工具 → 调用它们，**每次传 `projectPath: <当前工作区绝对路径>`**；首选 `codegraph_explore`，深度查询用 `codegraph_node`，全文检索用 `codegraph_search`。',
  '   - 没有 MCP 工具或调用失败 → 直接执行 shell 命令 `codegraph explore \\\\"<符号或问题>\\\\"`，不要等待重试。',
  '2. 只有以下情况才回退到 `grep` / `find` / `Read`：',
  '   - 需要完整文件内容（CodeGraph 只返回摘要或片段）；',
  '   - 需要执行命令（测试、构建、lint、扫描等）；',
  '   - 需要外部信息（文档、CVE、依赖版本等）；',
  '   - CodeGraph 工具不可用或返回结果不完整。',
  '3. 委托 `explore` / `code-reviewer` / `security-reviewer` 等子代理时，将以上两条规则原样写入其提示词开头，并要求其在报告中注明哪些结论来自 CodeGraph，哪些来自 `Read` / `grep`。',
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
