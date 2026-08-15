import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COOKIE_MAX_AGE_DAYS, COOKIE_NAME, dayIndex, ensurePairingSecret, mintCookie, pairingTicket, verifyCookie, verifyTicket,
} from '../src/secret.ts'

const DAY_MS = 86_400_000
let root: string | undefined

// The race arms below exercise the module's fs calls; everything else runs the real implementations.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), readFile: vi.fn(actual.readFile) }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) }
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-remote-secret-'))
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const secretPath = (): string => join(root!, 'secrets', 'remote-pair')

describe('ensurePairingSecret', () => {
  it('creates a 32-byte secret under a 0700 directory with a 0600 file', async () => {
    const secret = await ensurePairingSecret(secretPath(), false)
    expect(secret).toHaveLength(32)
    expect((await stat(secretPath())).mode & 0o777).toBe(0o600)
    expect((await stat(join(root!, 'secrets'))).mode & 0o777).toBe(0o700)
    expect(await readFile(secretPath())).toEqual(secret)
  })

  it('re-reads the persisted secret instead of regenerating', async () => {
    const first = await ensurePairingSecret(secretPath(), false)
    const second = await ensurePairingSecret(secretPath(), false)
    expect(second).toEqual(first)
  })

  it('creates fresh on reset when no secret exists yet', async () => {
    const secret = await ensurePairingSecret(secretPath(), true)
    expect(secret).toHaveLength(32)
  })

  it('rotates the secret on reset', async () => {
    const first = await ensurePairingSecret(secretPath(), false)
    const rotated = await ensurePairingSecret(secretPath(), true)
    expect(rotated).not.toEqual(first)
    expect(rotated).toHaveLength(32)
  })

  it('removes a link-shaped secret without following it', async () => {
    const target = join(root!, 'target-secret')
    await writeFile(target, randomBytes(32))
    await mkdir(join(root!, 'secrets'), { recursive: true })
    await symlink(target, secretPath())
    const secret = await ensurePairingSecret(secretPath(), true)
    expect(secret).toHaveLength(32)
    expect(await readFile(target)).toHaveLength(32)
  })

  it('refuses a secret file whose length is not 32 bytes', async () => {
    await mkdir(join(root!, 'secrets'), { recursive: true })
    await writeFile(secretPath(), Buffer.from('short'))
    await expect(ensurePairingSecret(secretPath(), false)).rejects.toThrow(/exactly 32 bytes/)
  })

  it('rejects a directory at the secret path, with and without reset', async () => {
    await mkdir(secretPath(), { recursive: true })
    await expect(ensurePairingSecret(secretPath(), false)).rejects.toThrow(/EISDIR/)
    await expect(ensurePairingSecret(secretPath(), true)).rejects.toThrow(/EISDIR/)
  })

  it('rethrows a non-EEXIST write failure', async () => {
    const writeFileMock = vi.mocked(writeFile)
    writeFileMock.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    await expect(ensurePairingSecret(secretPath(), false)).rejects.toThrow(/permission denied/)
  })

  it('adopts the concurrent creator secret when the exclusive open loses the race', async () => {
    const writeFileMock = vi.mocked(writeFile)
    const readFileMock = vi.mocked(readFile)
    const baseReadFile = readFileMock.getMockImplementation()!
    writeFileMock.mockRejectedValueOnce(Object.assign(new Error('already exists'), { code: 'EEXIST' }))
    const raced = Buffer.alloc(32, 9)
    let first = true
    readFileMock.mockImplementation(async (path, options) => {
      if (first) {
        first = false
        return baseReadFile(path, options)
      }
      return raced
    })
    try {
      await expect(ensurePairingSecret(secretPath(), false)).resolves.toEqual(raced)
    } finally {
      readFileMock.mockImplementation(baseReadFile)
    }
  })

  it('fails loud when the raced creator secret disappears', async () => {
    const writeFileMock = vi.mocked(writeFile)
    const readFileMock = vi.mocked(readFile)
    const baseReadFile = readFileMock.getMockImplementation()!
    writeFileMock.mockRejectedValueOnce(Object.assign(new Error('already exists'), { code: 'EEXIST' }))
    let first = true
    readFileMock.mockImplementation(async (path, options) => {
      if (first) {
        first = false
        return baseReadFile(path, options)
      }
      throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    })
    try {
      await expect(ensurePairingSecret(secretPath(), false)).rejects.toThrow(/disappeared during creation/)
    } finally {
      readFileMock.mockImplementation(baseReadFile)
    }
  })

  it('rethrows a non-ENOENT stat failure during reset', async () => {
    vi.mocked(lstatSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    await expect(ensurePairingSecret(secretPath(), true)).rejects.toThrow(/permission denied/)
  })
})

describe('pairing tickets', () => {
  it('derives deterministically and verifies within the same UTC day', () => {
    const secret = randomBytes(32)
    const now = Date.UTC(2026, 7, 14, 12, 0, 0)
    const ticket = pairingTicket(secret, now)
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{20,30}$/)
    expect(verifyTicket(secret, ticket, now)).toBe(true)
    expect(verifyTicket(secret, ticket, now + 3_600_000)).toBe(true)
  })

  it('rotates with the day index and rejects tampering', () => {
    const secret = randomBytes(32)
    const now = Date.UTC(2026, 7, 14, 12, 0, 0)
    const ticket = pairingTicket(secret, now)
    expect(verifyTicket(secret, ticket, now + DAY_MS)).toBe(false)
    expect(verifyTicket(secret, 'AAAA', now)).toBe(false)
    expect(verifyTicket(randomBytes(32), ticket, now)).toBe(false)
  })
})

describe('session cookies', () => {
  it('round-trips through verifyCookie', () => {
    const secret = randomBytes(32)
    const now = Date.UTC(2026, 7, 14, 12, 0, 0)
    const { value } = mintCookie(secret, now)
    expect(value).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{32}$/)
    expect(verifyCookie(secret, value, now)).toBe(true)
    expect(verifyCookie(secret, value, now + COOKIE_MAX_AGE_DAYS * DAY_MS - 1)).toBe(true)
  })

  it('rejects expiry, tampering, and malformed values', () => {
    const secret = randomBytes(32)
    const now = Date.UTC(2026, 7, 14, 12, 0, 0)
    const { value } = mintCookie(secret, now)
    expect(verifyCookie(secret, value, now + (COOKIE_MAX_AGE_DAYS + 1) * DAY_MS)).toBe(false)
    expect(verifyCookie(secret, undefined, now)).toBe(false)
    expect(verifyCookie(secret, 'garbage', now)).toBe(false)
    expect(verifyCookie(secret, 'v1.' + String(dayIndex(now) + 1) + '.AAAA', now)).toBe(false)
    expect(verifyCookie(randomBytes(32), value, now)).toBe(false)
    expect(COOKIE_NAME).toBe('dsh_remote')
  })
})

