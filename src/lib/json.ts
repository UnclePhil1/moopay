/** Single serializer for everything that crosses the MCP boundary: bigint -> decimal string. */
export const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(value, bigintReplacer, space);
}
