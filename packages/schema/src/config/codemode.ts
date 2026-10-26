export * as ConfigCodeMode from "./codemode.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.CodeMode")({
  timeout: Schema.Union([PositiveInt, Schema.Literal(false)]).pipe(optional).annotate({
    description: "Maximum time in milliseconds for one Code Mode execution. Defaults to 10 minutes; false disables it.",
  }),
}) {}
