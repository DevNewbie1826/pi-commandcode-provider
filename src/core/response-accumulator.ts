import {
  isRecord,
  mapFinishReason,
  numberValue,
  recordOrEmpty,
  stringValue,
} from "../converters.ts"
import type {
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  AssistantMessageLike,
  ModelLike,
  TextContent,
  ToolCallContent,
  Usage,
} from "../types.ts"
import { applyFinishUsage, defaultUsage, streamErrorMessage } from "./policy.ts"

/**
 * Accumulates a single Command Code streaming response into an
 * AssistantMessageLike, pushing start/delta/end events to the host stream.
 *
 * Owns text-block, thinking-block, and tool-call transitions and the finished
 * flag. The transport loop in core.ts reads bytes, frames lines, and forwards
 * parsed events here.
 */
export class ResponseAccumulator {
  readonly #stream: AssistantMessageEventStreamLike
  readonly #output: AssistantMessageLike
  readonly #model: ModelLike
  readonly #calculateCost: (model: ModelLike, usage: Usage) => void
  #textBlock: TextContent | undefined
  #currentTextIdx = -1
  #thinkingIdx = -1
  #finished = false

  constructor(
    stream: AssistantMessageEventStreamLike,
    model: ModelLike,
    calculateCost: (model: ModelLike, usage: Usage) => void,
    now: () => number,
  ) {
    this.#stream = stream
    this.#model = model
    this.#calculateCost = calculateCost
    this.#output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: defaultUsage(),
      stopReason: "stop",
      timestamp: now(),
    }
  }

  get output(): AssistantMessageLike {
    return this.#output
  }

  get finished(): boolean {
    return this.#finished
  }

  get hasVisibleContent(): boolean {
    return this.#output.content.length > 0
  }

  reset(): void {
    this.#output.content.length = 0
    this.#textBlock = undefined
    this.#currentTextIdx = -1
    this.#thinkingIdx = -1
    this.#output.stopReason = "stop"
    this.#output.errorMessage = undefined
    this.#finished = false
  }

  pushStart(): void {
    this.#stream.push({ type: "start", partial: this.#output })
  }

  endTextBlock(): void {
    if (!this.#textBlock) return
    this.#stream.push({
      type: "text_end",
      contentIndex: this.#currentTextIdx,
      content: this.#textBlock.text,
      partial: this.#output,
    })
    this.#textBlock = undefined
    this.#currentTextIdx = -1
  }

  endThinking(): void {
    if (this.#thinkingIdx < 0) return
    const tc = this.#output.content[this.#thinkingIdx]
    if (tc && tc.type === "thinking") {
      this.#stream.push({
        type: "thinking_end",
        contentIndex: this.#thinkingIdx,
        content: (tc as { thinking: string }).thinking,
        partial: this.#output,
      })
    }
    this.#thinkingIdx = -1
  }

  handle(event: unknown): void {
    if (!isRecord(event)) return

    switch (event.type) {
      case "text-delta": {
        this.endThinking()
        if (!this.#textBlock) {
          this.#textBlock = { type: "text", text: "" }
          this.#output.content.push(this.#textBlock)
          this.#currentTextIdx = this.#output.content.length - 1
          this.#stream.push({
            type: "text_start",
            contentIndex: this.#currentTextIdx,
            partial: this.#output,
          })
        }
        const delta = stringValue(event.text) ?? ""
        this.#textBlock.text += delta
        this.#stream.push({
          type: "text_delta",
          contentIndex: this.#currentTextIdx,
          delta,
          partial: this.#output,
        })
        break
      }

      case "reasoning-start": {
        this.endTextBlock()
        break
      }

      case "reasoning-delta": {
        this.endTextBlock()
        const delta = stringValue(event.text) ?? ""
        if (this.#thinkingIdx < 0) {
          this.#output.content.push({ type: "thinking", thinking: delta })
          this.#thinkingIdx = this.#output.content.length - 1
          this.#stream.push({
            type: "thinking_start",
            contentIndex: this.#thinkingIdx,
            partial: this.#output,
          })
        } else {
          const tc = this.#output.content[this.#thinkingIdx]
          if (tc && tc.type === "thinking") {
            ;(tc as { thinking: string }).thinking += delta
          }
        }
        this.#stream.push({
          type: "thinking_delta",
          contentIndex: this.#thinkingIdx,
          delta,
          partial: this.#output,
        })
        break
      }

      case "reasoning-end": {
        this.endThinking()
        break
      }

      case "tool-result": {
        break
      }

      case "tool-call": {
        this.endTextBlock()
        this.endThinking()
        const toolCall: ToolCallContent = {
          type: "toolCall",
          id: stringValue(event.toolCallId) ?? "",
          name: stringValue(event.toolName) ?? "",
          arguments: recordOrEmpty(event.input ?? event.args ?? event.arguments),
        }
        this.#output.content.push(toolCall)
        const idx = this.#output.content.length - 1
        this.#stream.push({ type: "toolcall_start", contentIndex: idx, partial: this.#output })
        this.#stream.push({
          type: "toolcall_end",
          contentIndex: idx,
          toolCall,
          partial: this.#output,
        })
        break
      }

      case "finish": {
        applyFinishUsage(this.#output, event, this.#calculateCost, this.#model)
        this.#output.stopReason = mapFinishReason(event.finishReason)
        this.#finished = true
        break
      }

      case "error": {
        const message = streamErrorMessage(event)
        this.#output.stopReason = "error"
        this.#output.errorMessage = message
        throw new Error(message)
      }
    }
  }

  emitDone(): AssistantMessageEvent {
    return { type: "done", reason: "stop", message: this.#output }
  }
}
