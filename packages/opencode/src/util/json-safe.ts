export function toJsonSafe<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_, v) => {
      if (typeof v === "function" || typeof v === "symbol" || v === undefined) return undefined
      if (typeof v === "bigint") return v.toString()
      return v
    }),
  )
}
