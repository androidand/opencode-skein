import z from "zod"
import type { ZodType } from "zod"
import { Schema, Types } from "effect"
import { zod } from "@/util/effect-zod"

export type Definition = ReturnType<typeof define>

const registry = new Map<string, Definition>()

/**
 * Define a bus event type with a payload schema.
 *
 * Accepts either a Zod schema or an Effect Schema. Effect Schemas are
 * converted to Zod internally via the effect-zod walker so that the bus
 * continues to use Zod as the lingua franca for serialization/validation.
 */
export function define<Type extends string, P extends Schema.Top>(
  type: Type,
  properties: P,
): { type: Type; properties: z.ZodType<Types.DeepMutable<Schema.Schema.Type<P>>> }
export function define<Type extends string, P extends ZodType>(
  type: Type,
  properties: P,
): { type: Type; properties: P }
export function define(type: string, properties: unknown) {
  const zodProperties = Schema.isSchema(properties) ? zod(properties) : (properties as ZodType)
  const result = { type, properties: zodProperties }
  registry.set(type, result as Definition)
  return result
}

export function payloads() {
  return registry
    .entries()
    .map(([type, def]) => {
      return z
        .object({
          type: z.literal(type),
          properties: def.properties,
        })
        .meta({
          ref: `Event.${def.type}`,
        })
    })
    .toArray()
}

export * as BusEvent from "./bus-event"
