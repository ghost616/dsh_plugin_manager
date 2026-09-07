#!/usr/bin/env node
/**
 * Remove build artifacts: lib/ and leaf .tsbuildinfo files.
 * Usage: node scripts/clean.mjs
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const targets = [
  resolve(root, 'lib'),
  resolve(root, 'tsconfig.host.tsbuildinfo'),
  resolve(root, 'tsconfig.client.tsbuildinfo'),
]
for (const target of targets) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
    console.log(`removed ${target}`)
  }
}