// Keyless mobile-voice lane: the @deepseek-ai/dsh-client-mobile core drives
// the real assembled host through the fake cloudflared tunnel — pairing with
// cookie extraction, session RPCs over the /api fence, the mux WebSocket
// stream, and (replay mode) a full voice round trip whose speak-queue output
// is asserted. The LLM fixture is the one recorded by fresh-round-trip, whose
// drive prompt this lane repeats verbatim so the replay answers identically.
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import {
  MobileApiClient, VoiceChatController, pairWithHost,
  type SocketLike, type SpeechRecognizerPort, type SpeechSpeakerPort, type VoiceChatSnapshot,
} from '@deepseek-ai/dsh-client-mobile'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

// Mirrored from packages/remote/remote-access/src/secret.ts (pairingTicket):
// the lane cannot import package internals across project roots, and a drift
// between the two derivations fails this scenario loudly at pairing time.
function pairingTicket(secret: Buffer, now: number): string {
  const dayIndex = Math.floor(now / 86_400_000)
  return createHmac('sha256', secret).update('dsh-remote-ticket:v1:').update(String(dayIndex))
    .digest().subarray(0, 16).toString('base64url')
}

const MODE = webSnapshotMode()
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const FIXTURE_BIN = join(REPO_ROOT, 'apps/web/tests/support/fake-cloudflared.sh')
const FORWARDER = join(REPO_ROOT, 'apps/web/tests/support/fake-cloudflared-forwarder.mjs')
const FAKE_HOST = 'fake-slug.trycloudflare.com'
const FAKE_PORT = 39990
const FAKE_ORIGIN = 'https://' + FAKE_HOST + ':' + String(FAKE_PORT)
// The prompt fresh-round-trip recorded; replay only answers this exact prompt.
const DRIVE_PROMPT = 'Use the bash tool to run exactly: echo WEB_E2E_OK. Then reply with the single word DONE and stop.'
const REPLAY_FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))

/**
 * A fetch over the self-signed fake tunnel (undici would reject its cert):
 * manual redirects, streaming bodies, and full header fidelity.
 */
function tunnelFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input))
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    const initHeaders = init?.headers
    if (initHeaders !== undefined && typeof initHeaders === 'object' && !Array.isArray(initHeaders)) {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value === 'string') headers[key] = value
      }
    }
    const request = httpsRequest({
      host: '127.0.0.1',
      port: FAKE_PORT,
      path: url.pathname,
      method: init?.method ?? 'GET',
      headers: {
        ...headers,
        ...init?.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(init.body as string)) },
      },
      rejectUnauthorized: false,
      servername: FAKE_HOST,
    }, (response: IncomingMessage) => {
      const webHeaders = new Headers()
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) {
          for (const item of value) webHeaders.append(key, item)
        } else {
          webHeaders.append(key, value)
        }
      }
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: response.statusCode ?? 502,
        headers: webHeaders,
      }))
    })
    request.on('error', reject)
    if (init?.body === undefined) request.end()
    else request.end(init.body as string)
  })
}

/** A recognizer that never hears anything (the lane drives submitText). */
const silentRecognizer: SpeechRecognizerPort = {
  available: true,
  start: async () => undefined,
  stop: async () => undefined,
}

/** The core's WebSocket downlink over the self-signed fake tunnel: dial 127.0.0.1 with the fake Host. */
function tunnelSocket(url: string, headers: Record<string, string>): SocketLike {
  const target = new URL(url)
  target.hostname = '127.0.0.1'
  target.port = String(FAKE_PORT)
  const socket = new WebSocket(target.href, { headers: { ...headers, host: FAKE_HOST }, rejectUnauthorized: false })
  socket.on('unexpected-response', (_request, response) => {
    console.error('[e2e] tunnel socket upgrade rejected: HTTP ' + String(response.statusCode))
  })
  return socket as unknown as SocketLike
}

/** Wait until the fake tunnel answers the pairing gate (spawn takes a moment). */
async function waitForTunnel(): Promise<void> {
  await expect.poll(async () => {
    try {
      return (await tunnelFetch(FAKE_ORIGIN + '/')).status
    } catch {
      return 0
    }
  }, { timeout: 30_000 }).toBe(401)
}

describe.skipIf(MODE === 'record')('web e2e: mobile voice app over the remote tunnel', () => {
  let scaffold: WebScaffold
  let ticket: string

  beforeAll(async () => {
    process.env.DSH_REMOTE_FIXTURE_BIN = FIXTURE_BIN
    process.env.REMOTE_FIXTURE_FORWARDER = FORWARDER
    scaffold = await launchWebScaffold({
      extraOverlayPath: join(REPO_ROOT, 'apps/web/tests/remote-access.overlay.yml'),
      ...(MODE === 'record' ? {} : { replayFixture: REPLAY_FIXTURE, paceMs: 15 }),
    })
    const secret = await readFile(join(scaffold.harnessHome, 'secrets', 'remote-pair'))
    ticket = pairingTicket(secret, Date.now())
  }, 120_000)

  afterAll(async () => {
    delete process.env.DSH_REMOTE_FIXTURE_BIN
    delete process.env.REMOTE_FIXTURE_FORWARDER
    await scaffold?.close()
  })

  it('refuses unpaired API calls, then pairs into sessions and the mux stream', async () => {
    await waitForTunnel()
    const unpaired = await tunnelFetch(FAKE_ORIGIN + '/api/session.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'u1', method: 'session.list', payload: {} }),
    })
    expect(unpaired.status).toBe(401)

    const pairing = await pairWithHost(FAKE_ORIGIN + '/pair/' + ticket, tunnelFetch)
    expect(pairing.baseUrl).toBe(FAKE_ORIGIN)
    expect(pairing.cookie).not.toBe('')

    const spoken: { text: string; language: string }[] = []
    const speaker: SpeechSpeakerPort = {
      speak: (text, language, onDone) => {
        spoken.push({ text, language })
        onDone()
      },
      stop: () => undefined,
    }
    const snapshots: VoiceChatSnapshot[] = []
    const controller = new VoiceChatController({
      client: new MobileApiClient({
        baseUrl: pairing.baseUrl,
        cookie: pairing.cookie,
        fetchImpl: tunnelFetch,
        openSocket: tunnelSocket,
      }),
      recognizer: silentRecognizer,
      speaker,
      // Voice mode stays silent here; the round-trip test asserts speech.
      autoSpeak: false,
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot)
        // The recorded fixture may request a bash approval or ask a question:
        // answer it so the turn can settle (also exercises respond over the
        // tunnel).
        if (snapshot.pendingApproval !== null) {
          controller.answerApproval(snapshot.pendingApproval.approvalId, 'allowed-once')
        }
        if (snapshot.pendingQuestion !== null) {
          controller.answerQuestion(
            snapshot.pendingQuestion.questionRpcId,
            snapshot.pendingQuestion.questions.map(question => ({ id: question.id, selected: [] })),
          )
        }
      },
    })
    controller.connect()
    await expect.poll(() => snapshots.at(-1)?.connection, { timeout: 30_000 }).toBe('online')
    expect(snapshots.at(-1)?.sessionId).not.toBe('')
    controller.dispose()
  }, 120_000)

  it('runs a keyless voice round trip: prompt, tool execution, streamed reply, spoken output', async () => {
    await waitForTunnel()
    const pairing = await pairWithHost(FAKE_ORIGIN + '/pair/' + ticket, tunnelFetch)
    const spoken: string[] = []
    const speaker: SpeechSpeakerPort = {
      speak: (text, _language, onDone) => {
        spoken.push(text)
        onDone()
      },
      stop: () => undefined,
    }
    const snapshots: VoiceChatSnapshot[] = []
    const controller = new VoiceChatController({
      client: new MobileApiClient({
        baseUrl: pairing.baseUrl,
        cookie: pairing.cookie,
        fetchImpl: tunnelFetch,
        openSocket: tunnelSocket,
      }),
      recognizer: silentRecognizer,
      speaker,
      autoSpeak: true,
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot)
        if (snapshot.pendingApproval !== null) {
          controller.answerApproval(snapshot.pendingApproval.approvalId, 'allowed-once')
        }
        if (snapshot.pendingQuestion !== null) {
          controller.answerQuestion(
            snapshot.pendingQuestion.questionRpcId,
            snapshot.pendingQuestion.questions.map(question => ({ id: question.id, selected: [] })),
          )
        }
      },
    })
    controller.connect()
    await expect.poll(() => snapshots.at(-1)?.connection, { timeout: 30_000 }).toBe('online')
    controller.submitText(DRIVE_PROMPT)
    // The replay fixture streams chunks at paceMs; wait for the turn to settle
    // with the assistant's DONE text visible and spoken.
    await expect.poll(
      () => snapshots.some(snapshot =>
        !snapshot.turnRunning
        && snapshot.messages.some(message => message.kind === 'assistant' && message.text.includes('DONE'))),
      { timeout: 60_000 },
    ).toBe(true)
    expect(snapshots.at(-1)?.toolLines.some(line => line.name === 'bash')).toBe(true)
    await expect.poll(() => spoken.some(text => text.includes('DONE')), { timeout: 10_000 }).toBe(true)
    controller.dispose()
  }, 120_000)
})
