export function toJsonSafe<T>(value: T): T {
  const ancestors: object[] = []
  const json = JSON.stringify(value, function (this: unknown, _key, v) {
    if (typeof v === "function" || typeof v === "symbol" || v === undefined) return undefined
    if (typeof v === "bigint") return v.toString()
    if (v === null || typeof v !== "object") return v
    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()
    if (ancestors.includes(v)) return undefined
    ancestors.push(v)
    return v
  })
  return json === undefined ? (undefined as T) : JSON.parse(json)
}
