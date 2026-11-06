/**
 * The crew presets as a profile bundle. Its patch composes the roles, and its
 * module exports the commander-only structured Git plugin.
 * @module @deepseek-ai/dsh-crew
 */

export { apply, Config, inject, name } from './git.ts'
export { CrewGitError } from './git.ts'
