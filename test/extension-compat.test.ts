import { expect, test } from "bun:test"
import { access, readFile } from "node:fs/promises"

import { isRecord } from "../src/converters.ts"

test("registers with pi senpi and omp compatible APIs", async () => {
  const expectedEntrypoint = "./src/index.ts"
  const runtimes = ["pi", "senpi", "omp"]
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  )

  for (const runtime of runtimes) {
    const config = isRecord(manifest) ? manifest[runtime] : undefined
    const extensions =
      isRecord(config) && Array.isArray(config.extensions)
        ? config.extensions.filter((entry): entry is string => typeof entry === "string")
        : []
    expect(extensions).toContain(expectedEntrypoint)
  }

  await access(new URL("../src/index.ts", import.meta.url))
})

test("packaged entrypoints all resolve to existing files", async () => {
  // Dynamic import of the real entrypoint is not feasible under bun: it pulls
  // in the optional host peer deps (@earendil-works/pi-ai etc.) which are not
  // installed. Instead, statically resolve every declared extension file.
  const runtimes = ["pi", "senpi", "omp"]
  const manifest: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  )
  const manifestUrl = new URL("../package.json", import.meta.url)

  for (const runtime of runtimes) {
    const config = isRecord(manifest) ? manifest[runtime] : undefined
    const extensions =
      isRecord(config) && Array.isArray(config.extensions)
        ? config.extensions.filter((entry): entry is string => typeof entry === "string")
        : []
    expect(extensions).not.toHaveLength(0)

    for (const entry of extensions) {
      await access(new URL(entry, manifestUrl))
    }
  }
})

test("packaged entrypoint re-export target exists", async () => {
  // src/index.ts re-exports the root entrypoint; a dangling re-export breaks
  // every host at load time even though the manifest file itself exists.
  const entrypointText = await readFile(new URL("../src/index.ts", import.meta.url), "utf8")
  const reExport = /export\s*\{\s*default\s*\}\s*from\s*"([^"]+)"/.exec(entrypointText)
  const specifier = reExport?.[1]
  if (specifier === undefined) throw new Error("src/index.ts must re-export a default export")

  await access(new URL(specifier, new URL("../src/index.ts", import.meta.url)))
})
