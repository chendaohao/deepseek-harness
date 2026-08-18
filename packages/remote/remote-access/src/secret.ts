/**
 * Pairing-secret file handling and the HMAC cookie vocabulary of the
 * remote-access capability. The master secret never appears in a URL: pairing
 * uses a one-time token minted by the device registry, and the session cookie
 * is an HMAC-SHA256 derivation over the device id and its expiry day.
 * @module @deepseek-ai/dsh-remote-access/secret
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { lstatSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

/** Master-secret length in bytes. */
const SECRET_BYTES = 32
/** Days a minted cookie stays valid. */
export const COOKIE_MAX_AGE_DAYS = 30
/** Cookie lifetime in seconds, for the Max-Age attribute. */
export const COOKIE_MAX_AGE_SECONDS = COOKIE_MAX_AGE_DAYS * 86_400
/** Session-cookie name shared by minting and verification. */
export const COOKIE_NAME = 'dsh_remote'
/** HMAC domain separator for session cookies. */
const COOKIE_CONTEXT = 'dsh-remote-cookie:v2:'
/** Milliseconds per UTC day; cookie expiry counts by day index. */
const DAY_MS = 86_400_000

/**
 * The UTC day index used to scope cookie expiry.
 * @param now - current time in epoch milliseconds.
 * @returns the day number (floor of now over one day).
 */
export function dayIndex(now: number): number {
  return Math.floor(now / DAY_MS)
}

/**
 * Mint a session-cookie value bound to one device id, plus its expiry day.
 * @param secret - the master pairing secret.
 * @param deviceId - the paired device the cookie admits.
 * @param now - current time; expiry counts from its day index.
 * @returns the cookie value and the day it expires.
 */
export function mintCookie(secret: Buffer, deviceId: string, now: number): { value: string; expiresDay: number } {
  const expiresDay = dayIndex(now) + COOKIE_MAX_AGE_DAYS
  const mac = hmac(secret, COOKIE_CONTEXT, deviceId + '|' + String(expiresDay)).subarray(0, 24)
  const value = 'v2.' + deviceId + '.' + String(expiresDay) + '.' + base64Url(mac)
  return { value, expiresDay }
}

/**
 * Verify a session-cookie value: format, expiry, and HMAC, in constant time.
 * @param secret - the master pairing secret.
 * @param value - the presented cookie value, if any.
 * @param now - current time; the expiry day must not have passed.
 * @returns the admitted device id, or undefined for an unexpired-or-tampered cookie.
 */
export function verifyCookie(secret: Buffer, value: string | undefined, now: number): string | undefined {
  if (value === undefined) return undefined
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== 'v2') return undefined
  const deviceId = parts[1] ?? ''
  const expiresDay = Number(parts[2])
  /* v8 ignore next -- a four-part value always has an element at index 3 */
  const mac = parts[3] ?? ''
  if (deviceId === '' || !Number.isInteger(expiresDay) || expiresDay < dayIndex(now)) return undefined
  const expected = hmac(secret, COOKIE_CONTEXT, deviceId + '|' + String(expiresDay)).subarray(0, 24)
  if (!constantTimeEqual(Buffer.from(mac, 'base64url'), expected)) return undefined
  return deviceId
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

