import { isRecord, stringValue } from "../converters.ts"
import type { ToolLike } from "../types.ts"

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

export function toJsonSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return {}

  const kind = stringValue(schema.kind) ?? stringValue(schema.type)
  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined
  if (enumValues) {
    return { type: typeof enumValues[0], enum: enumValues }
  }

  switch (kind) {
    case "string":
    case "String":
      return { type: "string" }
    case "number":
    case "Number":
      return { type: "number" }
    case "boolean":
    case "Boolean":
      return { type: "boolean" }
    case "object":
    case "Object": {
      const properties: Record<string, unknown> = {}
      const inferredRequired: string[] = []
      const sourceProperties = isRecord(schema.properties) ? schema.properties : undefined
      const optional = Array.isArray(schema.optional)
        ? schema.optional.filter((item): item is string => typeof item === "string")
        : []

      if (sourceProperties) {
        for (const [key, value] of Object.entries(sourceProperties)) {
          properties[key] = toJsonSchema(value)
          const valueRecord = isRecord(value) ? value : undefined
          if (booleanValue(valueRecord?.optional) !== true && !optional.includes(key)) {
            inferredRequired.push(key)
          }
        }
      }

      const explicitRequired = Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : undefined
      const required = explicitRequired ?? inferredRequired
      const out: Record<string, unknown> = { type: "object" }
      if (Object.keys(properties).length > 0) out.properties = properties
      if (required.length > 0) out.required = required
      return out
    }
    case "array":
    case "Array":
      return {
        type: "array",
        items: toJsonSchema(schema.items ?? schema.element),
      }
    case "union":
    case "Union": {
      const variants = Array.isArray(schema.variants)
        ? schema.variants
        : Array.isArray(schema.anyOf)
          ? schema.anyOf
          : []
      for (const variant of variants) {
        const converted = toJsonSchema(variant)
        if (isRecord(converted) && Object.keys(converted).length > 0) return converted
      }
      return {}
    }
    case "optional":
    case "Optional":
      return toJsonSchema(schema.wrapped ?? schema.inner)
    default:
      return {}
  }
}

export function toolsToJson(tools?: readonly ToolLike[]): unknown[] {
  if (!tools) return []
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters ? toJsonSchema(tool.parameters) : {},
  }))
}
