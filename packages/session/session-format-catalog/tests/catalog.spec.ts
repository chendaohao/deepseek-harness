import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { RELEASED_V2_EVENT_TYPES } from '@deepseek-ai/dsh-session-format-v1-to-v2'
import { sessionFormatCatalog } from '../src/index.ts'

describe('first-party Session format catalog', () => {
  it('statically owns the complete adjacent v0 to v2 chain', () => {
    const header = {
      type: 'session',
      version: 0,
      id: 'catalog',
      createdAt: 1,
      seedLength: 0,
      delegationDepth: 0,
    }

    expect(sessionFormatCatalog.currentVersion).toBe(2)
    expect(sessionFormatCatalog.readHeader(header)).toEqual({
      status: 'migration-required',
      storedVersion: 0,
      targetVersion: 2,
      header: {
        version: 2,
        id: 'catalog',
        createdAt: 1,
        isSeeded: true,
        delegationDepth: 0,
      },
    })

    const v1Header = { ...header, version: 1 }
    const current = sessionFormatCatalog.decodeArtifact(v1Header, [
      { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
    ])
    expect(sessionFormatCatalog.migrate(current)).toMatchObject({
      header: { version: 2, id: 'catalog' },
    })
  })

  it('restores the installed current vocabulary without freezing ordinary payload additions', () => {
    const header = {
      type: 'session', version: 2, id: 'current-growth', createdAt: 1, isSeeded: false, delegationDepth: 0,
    }
    const extended = sessionFormatCatalog.decodeArtifact(header, [{
      type: 'turn/start', seq: 0, time: 1, data: { turn: 1, postReleaseMember: true },
    }])
    expect(sessionFormatCatalog.migrate(extended).events).toEqual(extended.events)

    const unknownRequired = sessionFormatCatalog.decodeArtifact(header, [{
      type: 'ordinary/not-installed', seq: 0, time: 1, data: 'future',
    }])
    expect(() => sessionFormatCatalog.migrate(unknownRequired)).toThrow(/unknown event type/)

    const extension = sessionFormatCatalog.decodeArtifact(header, [{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
    expect(sessionFormatCatalog.migrate(extension).events).toEqual([{
      type: 'ordinary/external', seq: 0, time: 1, data: null, ignorable: true,
    }])
  })

  it('admits every installed event type through the newest released inventory', () => {
    expect(
      [...KNOWN_SESSION_EVENT_TYPES].filter(type => !RELEASED_V2_EVENT_TYPES.includes(type)),
      'a SessionEventMap member is missing from the newest released inventory; extend that inventory in the same change',
    ).toEqual([])
  })

  it('migrates a v0 log with session/pin events through the complete chain', () => {
    const header = {
      type: 'session', version: 0, id: 'pinned-era', createdAt: 1, delegationDepth: 0,
    }
    const rows = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'session/pin', seq: 1, time: 2, data: { pinned: true } },
      { type: 'session/pin', seq: 2, time: 3, data: { pinned: false } },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    ]

    const migrated = sessionFormatCatalog.migrate(sessionFormatCatalog.decodeArtifact(header, rows))
    expect(migrated.header.version).toBe(2)
    expect(migrated.events).toEqual(rows)
  })
})
