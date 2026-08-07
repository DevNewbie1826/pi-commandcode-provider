declare module "@earendil-works/pi-ai" {
  import type { AssistantMessageEvent, AssistantMessageEventStreamLike } from "./types.ts"

  export class AssistantMessageEventStream implements AssistantMessageEventStreamLike {
    push(event: AssistantMessageEvent): void
    end(): void
    [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent>
  }
}

declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    registerProvider(name: string, config: unknown): void
  }

  export function getAgentDir(): string
}
