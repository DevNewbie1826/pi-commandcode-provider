import { z } from "zod"

const accountId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

const token = z
  .string()
  .trim()
  .min(1)
  .max(8_192)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "token contains control characters")

// Max representable JS Date time value (ms); larger values make
// `new Date(retryAt).toISOString()` throw a RangeError.
export const MAX_DATE_MS = 8.64e15

export const accountSchema = z.object({
  id: accountId,
  token,
  enabled: z.boolean().default(true),
  retryAt: z.number().int().nonnegative().max(MAX_DATE_MS).optional(),
  createdAt: z.string().datetime().optional(),
})

export const accountFileSchema = z
  .object({
    version: z.literal(1),
    cursor: z.number().int().nonnegative(),
    accounts: z.array(accountSchema),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>()
    const tokens = new Set<string>()
    for (const account of value.accounts) {
      if (ids.has(account.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate account id: ${account.id}`,
          path: ["accounts"],
        })
      }
      ids.add(account.id)
      if (tokens.has(account.token)) {
        context.addIssue({
          code: "custom",
          message: `duplicate account token (account id: ${account.id})`,
          path: ["accounts"],
        })
      }
      tokens.add(account.token)
    }
  })

export type AccountRecord = z.infer<typeof accountSchema>
export type AccountFile = z.infer<typeof accountFileSchema>

export const emptyAccountFile = (): AccountFile => ({
  version: 1,
  cursor: 0,
  accounts: [],
})

export function parseAccountFile(value: unknown): AccountFile {
  const result = accountFileSchema.safeParse(value)
  if (!result.success) {
    throw new Error("Invalid account credentials")
  }
  return result.data
}

export function parseAccount(value: unknown): AccountRecord {
  const result = accountSchema.safeParse(value)
  if (!result.success) {
    throw new Error("Invalid account credentials")
  }
  return result.data
}
