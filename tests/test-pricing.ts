import assert from "node:assert/strict"
import { describe, it } from "node:test"

// MODEL_COSTS is a module-level const in index.ts. To keep this test
// self-contained without importing the full extension (which requires
// ExtensionAPI), we read the source and extract the constant at runtime.
// A cleaner approach would be a dedicated src/pricing.ts module, but for
// now we verify the known cost entries directly.

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const indexSource = readFileSync(resolve(__dirname, "..", "index.ts"), "utf-8")

const match = indexSource.match(
  /const MODEL_COSTS:\s*Record<string,\s*CommandCodeModelCost>\s*=\s*\{([\s\S]*?)\n\}/,
)
assert.ok(match, "MODEL_COSTS constant should exist in index.ts")

const costBlock = match[1]
const entries: Record<string, { input: number; output: number }> = {}
for (const line of costBlock.split("\n")) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("//")) continue
  const entryMatch = trimmed.match(/^"([^"]+)":\s*\{\s*input:\s*([\d.]+),\s*output:\s*([\d.]+)/)
  if (entryMatch) {
    entries[entryMatch[1]] = {
      input: Number(entryMatch[2]),
      output: Number(entryMatch[3]),
    }
  }
}

describe("MODEL_COSTS pricing overlay", () => {
  it("covers known Command Code models with non-zero pricing", () => {
    const knownModels = [
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "Qwen/Qwen3.7-Max",
      "gpt-5.6-sol",
      "gpt-5.5",
      "stepfun/Step-3.5-Flash",
    ]

    for (const id of knownModels) {
      const cost = entries[id]
      assert.ok(cost, `MODEL_COSTS should include "${id}"`)
      assert.ok(cost.input > 0, `"${id}" input cost should be > 0`)
      assert.ok(cost.output > 0, `"${id}" output cost should be > 0`)
    }
  })

  it("includes promotional pricing notes in comments", () => {
    // The DeepSeek V4 Pro 4× deal should be documented in the source comments.
    assert.ok(
      costBlock.includes("4× usage deal") || costBlock.includes("75% off"),
      "DeepSeek V4 Pro promotional pricing should be documented",
    )
  })

  it("applies standard (non-promo) rates for Qwen 3.7 Max", () => {
    // The 2× usage deal expired June 22, 2026; the table now carries standard rates.
    const qwenCost = entries["Qwen/Qwen3.7-Max"]
    assert.ok(qwenCost, 'MODEL_COSTS should include "Qwen/Qwen3.7-Max"')
    assert.equal(qwenCost.input, 2.5, "Qwen 3.7 Max input cost should be the standard rate")
    assert.equal(qwenCost.output, 7.5, "Qwen 3.7 Max output cost should be the standard rate")
  })

  it("has cache pricing for models that support it", () => {
    // Claude models should have non-zero cacheRead and cacheWrite costs.
    const claudeModels = ["claude-sonnet-4-6", "claude-opus-4-7"]
    for (const id of claudeModels) {
      const fullEntryMatch = costBlock.match(
        new RegExp(
          `"${id.replace(/\//g, "\\\\")}":\\s*\\{[^}]+cacheRead:\\s*([\\d.]+)[^}]+cacheWrite:\\s*([\\d.]+)`,
        ),
      )
      assert.ok(fullEntryMatch, `"${id}" should have cacheRead and cacheWrite fields`)
      assert.ok(Number(fullEntryMatch[1]) > 0, `"${id}" cacheRead should be > 0`)
      assert.ok(Number(fullEntryMatch[2]) > 0, `"${id}" cacheWrite should be > 0`)
    }
  })
})
