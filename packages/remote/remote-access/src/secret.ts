/**
 * Pairing-secret file handling and the HMAC ticket/cookie vocabulary of the
 * remote-access capability. The master secret never appears in a URL: the
 * pairing ticket rotates with the UTC day, and the session cookie carries one
 * opaque per-device identity whose HMAC binds it to the secret; expiry lives
 * in the device registry, not in the cookie.
 * @module @deepseek-ai/dsh-remote-access/secret
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { lstatSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Master-secret length in bytes. */
const SECRET_BYTES = 32
/** Opaque identity of one bound device, carried by the v2 session cookie. */
export type DeviceId = Branded<'RemoteDeviceId'>
/** Cookie Max-Age in days: the browser-side refresh cadence; server-side expiry lives in the registry. */
export const COOKIE_MAX_AGE_DAYS = 30
/** Cookie Max-Age in seconds, for the Set-Cookie attribute. */
export const COOKIE_MAX_AGE_SECONDS = COOKIE_MAX_AGE_DAYS * 86_400
/** Session-cookie name shared by minting and verification. */
export const COOKIE_NAME = 'dsh_remote'
/** HMAC domain separator for pairing tickets. */
const TICKET_CONTEXT = 'dsh-remote-ticket:v1:'
/** HMAC domain separator for session cookies. */
const COOKIE_CONTEXT = 'dsh-remote-cookie:v2:'
/** Accepted device-id spelling in a v2 cookie: URL-safe token. */
const deviceIdPattern = /^[A-Za-z0-9_-]+$/
/** Milliseconds per UTC day; tickets rotate with the day index. */
const DAY_MS = 86_400_000

/**
 * The UTC day index used to scope pairing tickets.
 * @param now - current time in epoch milliseconds.
 * @returns the day number (floor of now over one day).
 */
export function dayIndex(now: number): number {
  return Math.floor(now / DAY_MS)
}

/**
 * Derive the pairing ticket valid for one UTC day.
 * @param secret - the master pairing secret.
 * @param now - current time; tickets derive from its day index.
 * @returns the URL-safe ticket string (16 HMAC bytes).
 */
export function pairingTicket(secret: Buffer, now: number): string {
  return base64Url(hmac(secret, TICKET_CONTEXT, String(dayIndex(now))).subarray(0, 16))
}

/**
 * Verify a pairing ticket against the current day, in constant time.
 * @param secret - the master pairing secret.
 * @param ticket - the ticket presented by the pairing request.
 * @param now - current time; the ticket must derive from its day index.
 * @returns true when the ticket matches the current day's derivation.
 */
export function verifyTicket(secret: Buffer, ticket: string, now: number): boolean {
  return constantTimeEqual(Buffer.from(ticket, 'utf8'), Buffer.from(pairingTicket(secret, now), 'utf8'))
}

/**
 * Mint one device binding's session cookie: v2.<deviceId>.<mac>, with a
 * fresh random device identity for the registry.
 * @param secret - the master pairing secret.
 * @returns the cookie value and the minted device id.
 */
export function mintCookie(secret: Buffer): { value: string; deviceId: DeviceId } {
  const deviceId = base64Url(randomBytes(16)) as DeviceId
  const value = 'v2.' + deviceId + '.' + base64Url(hmac(secret, COOKIE_CONTEXT, deviceId).subarray(0, 24))
  return { value, deviceId }
}

/**
 * Verify a v2 session-cookie value and recover its device identity: format
 * and HMAC, in constant time. Expiry is the registry's call, not the cookie's.
 * @param secret - the master pairing secret.
 * @param value - the presented cookie value, if any.
 * @returns the bound device id, or null for absent, malformed, or tampered values.
 */
export function verifyCookie(secret: Buffer, value: string | undefined): DeviceId | null {
  if (value === undefined) return null
  const parts = value.split('.')
  if (parts.length !== 3 || parts[0] !== 'v2') return null
  /* v8 ignore next -- a three-part value always has an element at index 1 */
  const deviceId = parts[1] ?? ''
  /* v8 ignore next -- a three-part value always has an element at index 2 */
  const mac = parts[2] ?? ''
  if (deviceId === '' || deviceId.length > 64 || !deviceIdPattern.test(deviceId)) return null
  const expected = hmac(secret, COOKIE_CONTEXT, deviceId).subarray(0, 24)
  return constantTimeEqual(Buffer.from(mac, 'base64url'), expected) ? deviceId as DeviceId : null
}

/**
 * Load the persisted master secret, creating the file when absent.
 * @param secretPath - secret file path (mode 0600 under a 0700 directory).
 * @param reset - when true, an existing file is removed first, rotating the secret.
 * @returns the 32-byte master secret.
 */
export async function ensurePairingSecret(secretPath: string, reset: boolean): Promise<Buffer> {
  if (reset) removeSecretFile(secretPath)
  const existing = await readSecretFile(secretPath)
  if (existing !== undefined) return existing
  const secret = randomBytes(SECRET_BYTES)
  await mkdir(dirname(secretPath), { recursive: true, mode: 0o700 })
  try {
    await writeFile(secretPath, secret, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    // A concurrent creator won the exclusive open; its file is the secret.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = await readSecretFile(secretPath)
    if (raced === undefined) throw new Error('remote-access: pairing secret disappeared during creation')
    return raced
  }
  return secret
}

/**
 * Read the secret file, refusing any content that is not exactly 32 bytes.
 * @param secretPath - secret file path.
 * @returns the secret, or undefined when the file does not exist.
 */
async function readSecretFile(secretPath: string): Promise<Buffer | undefined> {
  let content: Buffer
  try {
    content = await readFile(secretPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (content.length !== SECRET_BYTES) {
    throw new Error('remote-access: pairing secret ' + JSON.stringify(secretPath) + ' must be exactly ' + String(SECRET_BYTES) + ' bytes')
  }
  return content
}

/**
 * Remove a possibly link-shaped secret file without following links.
 * @param secretPath - secret file path.
 */
function removeSecretFile(secretPath: string): void {
  try {
    const stat = lstatSync(secretPath)
    if (stat.isSymbolicLink() || stat.isFile()) unlinkSync(secretPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Base64url-encode bytes without padding. */
function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

/** HMAC-SHA256 of a domain-separated input under the master secret. */
function hmac(secret: Buffer, context: string, input: string): Buffer {
  return createHmac('sha256', secret).update(context).update(input).digest()
}

/** Constant-time equality over equal-length buffers; length differs ⇒ false. */
function constantTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

