declare module "bun:test" {
  interface Matchers {
    readonly not: Matchers
    readonly rejects: Matchers
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toContain(expected: unknown): void
    toBeUndefined(): void
    toHaveLength(expected: number): void
    toBeInstanceOf(expected: unknown): void
    toThrow(expected?: unknown): void
  }

  function expect(value: unknown): Matchers
  namespace expect {
    export function objectContaining(expected: unknown): unknown
  }
  function test(name: string, testCase: () => void | Promise<void>): void
}
