import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { runWithRequestFacts } from '@deepseek-ai/dsh-client-connection'
import CredentialsController from '../src/credentials.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

/** A store whose `describe` carries more than the view declares, as a foreign provider might. */
class LeakyCredentials extends MemoryCredentials {
  override describe(): Promise<CredentialInfo> {
    return Promise.resolve(
      { configured: true, source: 'memory', writable: true, value: 'sk-leaked' } as CredentialInfo,
    )
  }
}

/** A store whose write rejects with a bare string, the way some client libraries do. */
class LiteralRejectingCredentials extends MemoryCredentials {
  override async set(): Promise<void> {
    throw 'the store refused'
  }
}

/** A store whose provider-owned policy rejects an otherwise valid write. */
class RejectingCredentials extends MemoryCredentials {
  override set(): Promise<void> {
    return Promise.reject(new Error('a read-only source shadows this reference'))
  }
}

async function boot(
  seed: Record<string, string> = {},
  provider: typeof MemoryCredentials = MemoryCredentials,
): Promise<CredentialsController> {
  const ctx = new Context()
  await ctx.plugin(provider, seed)
  await ctx.plugin(CredentialsController)
  return ctx.credentialsController
}

describe('the credentials Remote namespace a configuration surface calls', () => {
  it('publishes the credentials namespace from its own service key', async () => {
    const controller = await boot()
    const binding = controller.typertRemote
    expect(binding.serviceKey).toBe('credentialsController')
    expect(binding.namespace).toBe('credentials')
    expect(remoteMethods(controller)).toEqual([
      { method: 'describe', invocation: { kind: 'direct' } },
      { method: 'set', invocation: { kind: 'direct' } },
      { method: 'unset', invocation: { kind: 'direct' } },
    ])
  })

  it('reports the actionable configuration error while no credential provider is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(CredentialsController)
    for (const call of [
      () => ctx.credentialsController.describe(['DEEPSEEK_API_KEY']),
      () => ctx.credentialsController.set('DEEPSEEK_API_KEY', 'sk-live'),
      () => ctx.credentialsController.unset('DEEPSEEK_API_KEY'),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({
        code: 'gateway/internal',
        message: 'credentials service is absent: this deployment does not mount a credential provider (e.g. @deepseek-ai/dsh-credentials-local) in its composition',
        details: {},
      })
    }
  })

  it('describes a batch of references as one map, values excluded', async () => {
    const controller = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    const described = await controller.describe(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'])
    expect(described).toEqual({
      DEEPSEEK_API_KEY: { configured: true, source: 'memory', writable: true },
      OPENAI_API_KEY: { configured: false, writable: true },
    })
    expect(JSON.stringify(described)).not.toContain('sk-seeded')
  })

  it('reports an invalid reference as bad-request', async () => {
    const controller = await boot()
    for (const call of [
      () => controller.describe(['DEEPSEEK_API_KEY', 'not a var']),
      () => controller.set('not a var', 'sk-live'),
      () => controller.unset('not a var'),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
    }
  })

  it('answers the largest batch it accepts and reports one reference more as bad-request', async () => {
    const controller = await boot()
    const accepted = Array.from({ length: 64 }, (_unused, index) => `REF_${String(index)}`)
    expect(Object.keys(await controller.describe(accepted))).toHaveLength(64)
    const failure = await controller.describe([...accepted, 'REF_64']).catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
  })

  it('answers only the fields the view declares, whatever a provider returns', async () => {
    const controller = await boot({}, LeakyCredentials)
    const described = await controller.describe(['DEEPSEEK_API_KEY'])
    expect(described.DEEPSEEK_API_KEY).toEqual({ configured: true, source: 'memory', writable: true })
    expect(JSON.stringify(described)).not.toContain('sk-leaked')
  })

  it('stores and removes through the same references the batch describes', async () => {
    const controller = await boot()
    await controller.set('DEEPSEEK_API_KEY', 'sk-live')
    expect(await controller.describe(['DEEPSEEK_API_KEY']))
      .toEqual({ DEEPSEEK_API_KEY: { configured: true, source: 'memory', writable: true } })
    await controller.unset('DEEPSEEK_API_KEY')
    expect(await controller.describe(['DEEPSEEK_API_KEY']))
      .toEqual({ DEEPSEEK_API_KEY: { configured: false, writable: true } })
  })

  it('reports a refused write as credential/rejected naming only the reference', async () => {
    const controller = await boot({}, RejectingCredentials)
    const failure = await controller.set('DEEPSEEK_API_KEY', 'sk-live').catch((error: unknown) => error)
    const { code, message, details } = remoteErrorOf(failure) ?? {}
    expect(code).toBe('credential/rejected')
    expect(message).toContain('read-only source')
    expect(details).toEqual({ ref: 'DEEPSEEK_API_KEY' })
  })

  it('reports an empty value as bad-request', async () => {
    const controller = await boot()
    const failure = await controller.set('DEEPSEEK_API_KEY', '').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
  })

  it('stringifies a refusal that is not an Error', async () => {
    const controller = await boot({}, LiteralRejectingCredentials)
    const failure = await controller.set('DEEPSEEK_API_KEY', 'sk-live').catch((error: unknown) => error)
    expect(remoteErrorOf(failure)?.message).toBe('the store refused')
  })
})

describe('the forwarded-write fence on credentials', () => {
  it('reports every reference non-writable and refuses set/unset for a forwarded request', async () => {
    const controller = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    const described = await runWithRequestFacts(
      { headers: { 'x-dsh-proxied': '1' } },
      () => controller.describe(['DEEPSEEK_API_KEY']),
    )
    expect(described).toEqual({ DEEPSEEK_API_KEY: { configured: true, source: 'memory', writable: false } })
    const forwarded = { headers: { 'x-dsh-proxied': '1' } }
    for (const call of [
      () => runWithRequestFacts(forwarded, () => controller.set('DEEPSEEK_API_KEY', 'sk-live')),
      () => runWithRequestFacts(forwarded, () => controller.unset('DEEPSEEK_API_KEY')),
    ]) {
      const failure = await Promise.resolve().then(call).catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'settings/forwarded-write-disabled' })
    }
    // The seeded value survived both refused writes.
    const after = await controller.describe(['DEEPSEEK_API_KEY'])
    expect(after.DEEPSEEK_API_KEY).toMatchObject({ configured: true })
  })

  it('stays writable for a local request even with the header on another field', async () => {
    const controller = await boot()
    const described = await runWithRequestFacts(
      { headers: { 'x-forwarded-for': '203.0.113.9' } },
      () => controller.describe(['DEEPSEEK_API_KEY']),
    )
    expect(described).toEqual({ DEEPSEEK_API_KEY: { configured: false, writable: true } })
    await controller.set('DEEPSEEK_API_KEY', 'sk-live')
    await expect(controller.unset('DEEPSEEK_API_KEY')).resolves.toBeUndefined()
  })
})
