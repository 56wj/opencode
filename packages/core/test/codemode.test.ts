import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { Config as SchemaConfig } from "@opencode/schema/config"
import { ConfigCodeMode } from "@opencode/schema/config/codemode"
import { Effect, Fiber, Schema } from "effect"
import type { Info } from "@opencode/schema/tool"
import { TestClock } from "effect/testing"
import { it } from "./lib/effect"

const toolNode = AppNodeBuilder.build(Tool.node, [
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
])

const timeoutNode = AppNodeBuilder.build(Tool.node, [
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
  Config.node.replace(
    Config.testLayer([
      new SchemaConfig.Document({
        type: "document",
        info: new SchemaConfig.Info({ codemode: new ConfigCodeMode.Info({ timeout: 1 }) }),
      }),
    ]),
  ),
])

describe("CodeMode", () => {
  it.effect("owns registrations, execute, and catalog materialization", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) => {
        editor.namespace({ name: "empty", description: "No tools registered yet" })
        editor.add({
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.String,
          options: { pinned: true },
          execute: ({ text }) => Effect.succeed({ output: text }),
        })
      })

      const snapshot = yield* tools.snapshot()
      expect(snapshot.definitions.some((tool) => tool.name === "execute")).toBe(true)
      expect(snapshot.codeModeCatalog).toStrictEqual({
        tools: [
          {
            type: "tool",
            name: "echo",
            description: "Echo text",
            signature: "tools.echo({\n  text: string,\n}): Promise<string>",
            pinned: true,
          },
          {
            type: "namespace",
            name: "empty",
            description: "No tools registered yet",
            tools: [],
          },
        ],
      })
    }).pipe(Effect.scoped, Effect.provide(toolNode)),
  )

  it.effect("renders Effect numbers in built-in tool signatures as number", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const ref = Schema.String.annotate({ identifier: "Ref", description: "Element ref" })
      const sentinel = Schema.Literals(["NaN", "Infinity", "-Infinity"])
      const Measure = {
        name: "measure",
        description: "Measure",
        input: Schema.Struct({ ref, amount: Schema.Number, sentinel }),
        output: Schema.Struct({ exit: Schema.optionalKey(Schema.Number), sentinel }),
        execute: () => Effect.succeed({ output: { exit: 0, sentinel: "NaN" as const } }),
      } satisfies Info<any, any>
      yield* tools.transform((editor) => {
        editor.add(Measure)
        editor.add({ ...Measure, name: "direct", options: { codemode: false } })
      })

      const snapshot = yield* tools.snapshot()
      expect(snapshot.codeModeCatalog?.tools).toEqual([
        {
          type: "tool",
          name: "measure",
          description: "Measure",
          signature: [
            "tools.measure({",
            "  /** Element ref */",
            "  ref: string,",
            "  amount: number,",
            '  sentinel: "NaN" | "Infinity" | "-Infinity",',
            "}): Promise<{",
            "  exit?: number,",
            '  sentinel: "NaN" | "Infinity" | "-Infinity",',
            "}>",
          ].join("\n"),
          pinned: false,
        },
      ])
      // Provider definitions keep Effect's plain JSON Schema encoding.
      const direct = JSON.stringify(snapshot.definitions.find((tool) => tool.name === "direct"))
      expect(direct).toContain('{"anyOf":[{"type":"number"},{"type":"string","enum":["Infinity","-Infinity","NaN"]}]}')
      expect(direct).not.toContain("$ref")
    }).pipe(Effect.scoped, Effect.provide(toolNode)),
  )

  it.effect("bounds configured Code Mode executions without hanging the step", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) =>
        editor.add({
          name: "wait",
          description: "Never settles",
          input: Schema.Struct({}),
          options: { timeout: false },
          execute: () => Effect.never,
        }),
      )

      const snapshot = yield* tools.snapshot()
      const pending = snapshot.execute({
        sessionID: Session.ID.make("session"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("message"),
        call: {
          type: "tool-call",
          id: "execute",
          name: "execute",
          input: { code: "return await tools.wait({})" },
        },
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 millis")
      const result = yield* Fiber.join(pending)

      expect(result.output).toMatchObject({ error: true })
      expect(result.content).toContainEqual({ type: "text", text: "Execution timed out after 1ms." })
    }).pipe(Effect.scoped, Effect.provide(timeoutNode)),
  )

  it.effect("turns a timed out nested tool into a Code Mode tool error", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) =>
        editor.add({
          name: "wait",
          description: "Never settles",
          input: Schema.Struct({}),
          execute: () => Effect.never,
        }),
      )

      const result = yield* (yield* tools.snapshot()).execute({
        sessionID: Session.ID.make("session_nested_timeout"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("message_nested_timeout"),
        call: {
          type: "tool-call",
          id: "execute_nested_timeout",
          name: "execute",
          input: { code: "return await tools.wait({})" },
        },
      })

      expect(result.output).toMatchObject({
        error: true,
        toolCalls: [{ tool: "wait", status: "error", elapsedMs: expect.any(Number) }],
      })
      expect(result.output.output).toContain('timed out after 1ms')
    }).pipe(Effect.scoped, Effect.provide(timeoutNode)),
  )

  it.effect("keeps nested progress in the timed out call record", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      yield* tools.transform((editor) =>
        editor.add({
          name: "progress",
          description: "Reports progress then waits",
          input: Schema.Struct({}),
          execute: (_input, context) => context.progress({ phase: "running" }).pipe(Effect.andThen(Effect.never)),
        }),
      )

      const pending = (yield* tools.snapshot()).execute({
        sessionID: Session.ID.make("session_nested_progress"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("message_nested_progress"),
        call: {
          type: "tool-call",
          id: "execute_nested_progress",
          name: "execute",
          input: { code: "return await tools.progress({})" },
        },
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("1 millis")
      const result = yield* Fiber.join(pending)

      expect(result.output.toolCalls[0]).toMatchObject({
        metadata: { phase: "running" },
        elapsedMs: expect.any(Number),
        status: "error",
      })
    }).pipe(Effect.scoped, Effect.provide(timeoutNode)),
  )
})
