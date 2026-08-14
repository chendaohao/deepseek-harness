#!/usr/bin/env node
/** Keyless vision-agent driver: boot the fixture and prove the seam works. */

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'vision-test-driver'
const [configPath] = process.argv.slice(2)
if (configPath === undefined) throw new Error(`${NAME}: expected <config-path>`)

const uninstallFailLoud = installFailLoud(NAME)
let ctx: Context | undefined
try {
  loadEnv(NAME)
  ctx = await boot(NAME, resolveConfigPath(configPath, undefined))

  // The seam is mounted with the declared capability metadata.
  const vision = ctx.vision
  if (vision.visionRoute.provider !== 'vision-route' || vision.visionRoute.model !== 'vision-model') {
    throw new Error(`${NAME}: unexpected vision route ${JSON.stringify(vision.visionRoute)}`)
  }

  // The tool registered with the filesystem suite.
  const names = ctx.tools.schemas().map(tool => tool.name)
  if (!names.includes('vision_observe')) {
    throw new Error(`${NAME}: vision_observe not registered (${names.join(', ')})`)
  }

  // A real observation round trip through the attachment seam and the mock route.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64',
  )
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error(`${NAME}: no attachment service`)
  const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name: 'probe.png' })
  const observation = await vision.observe({ attachments: [ref], question: 'what is this?' }, undefined)
  if (!observation.evidence.includes('mock vision evidence')) {
    throw new Error(`${NAME}: unexpected evidence ${JSON.stringify(observation.evidence)}`)
  }
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    visionRoute: vision.visionRoute,
    tools: names,
    evidence: observation.evidence,
    usage: observation.usage,
  })}\n`)
} catch (error: unknown) {
  const chain: string[] = []
  const walk = (current: unknown) => {
    if (current instanceof Error) {
      chain.push(current.message)
      const aggregate = current as Error & { errors?: unknown[] }
      if (Array.isArray(aggregate.errors)) {
        for (const child of aggregate.errors) walk(child)
      } else {
        walk(aggregate.cause)
      }
    }
  }
  walk(error)
  process.stderr.write(chain.join('\n  caused by: '))
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
