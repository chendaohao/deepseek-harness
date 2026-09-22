/** Default model references remain live without a settings service. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import DefaultModel from '../src/index.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

it('reads complete selections from volatile config and clears omitted reasoning effort', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'p', model: 'm' })
  const consumer = ctx.agentDefaultModel
  await live.update({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  expect(consumer.currentSelection()).toEqual({ provider: 'q', model: 'n', reasoningEffort: 'high' })
  await live.replace({ provider: 'p', model: 'm' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
  await consumer.saveSelection({ provider: 'unsaved', model: 'unsaved' })
  expect(consumer.currentSelection()).toEqual({ provider: 'p', model: 'm' })
})

it('persists complete selections through its owning profile entry', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'next', reasoningEffort: ReasoningEffortId('high') })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'next', reasoningEffort: 'high' })
  await ctx.agentDefaultModel.saveSelection({ provider: 'test', model: 'final' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'final' })
  const standalone = new Context()
  onTestFinished(() => standalone.fiber.dispose())
  await standalone.plugin(DefaultModel, { provider: 'test', model: 'original' })
  await standalone.agentDefaultModel.saveSelection({ provider: 'test', model: 'ignored' })
  expect(standalone.agentDefaultModel.currentSelection().model).toBe('original')
})

it('layers a hand-written partial section over the entry', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const live = await liveConfig(ctx, DefaultModel, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  await live.update({ model: 'deepseek-reasoner' })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual({
    provider: 'deepseek-official', model: 'deepseek-reasoner',
  })
})

it('remembers, reads, and forgets an explicit effort per exact model route', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ctx } = await configurationFixture({ hmr: false })
  const model = ctx.agentDefaultModel
  expect(model.rememberedEffort('acme-gateway', 'acme-large')).toBeUndefined()

  await model.rememberEffort('acme-gateway', 'acme-large', 'high')
  expect(model.rememberedEffort('acme-gateway', 'acme-large')).toBe('high')
  // Routes are keyed independently.
  expect(model.rememberedEffort('acme-gateway', 'acme-plain')).toBeUndefined()

  await model.forgetEffort('acme-gateway', 'acme-large')
  expect(model.rememberedEffort('acme-gateway', 'acme-large')).toBeUndefined()
})

it('keeps the per-model memory when a selection write replaces the section', async () => {
  const { configurationFixture } = await import('../../../settings/settings/tests/configuration-fixture.ts')
  const { ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
  const { ctx } = await configurationFixture({ hmr: false })
  await ctx.agentDefaultModel.rememberEffort('acme-gateway', 'acme-large', 'high')
  await ctx.agentDefaultModel.saveSelection({
    provider: 'other-gateway', model: 'other-model', reasoningEffort: ReasoningEffortId('off'),
  })
  expect(ctx.agentDefaultModel.rememberedEffort('acme-gateway', 'acme-large')).toBe('high')
})
