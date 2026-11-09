/* Which MooPay this is: the real one, or a test run on someone's machine. The team's numbers page uses it to tell them apart. */
export type Env = "production" | "development";
export function where(): { env: Env; host: string } {
  const set = process.env["MOOPAY_ENV"];
  const env: Env = set === "production" || set === "development" ? set : process.env["FLY_APP_NAME"] || process.env["MOOPAY_PUBLIC_HOST"] ? "production" : "development";
  return { env, host: (process.env["MOOPAY_PUBLIC_HOST"] ?? "localhost").replace(/^https?:\/\//, "").replace(/\/.*$/, "").slice(0, 80) || "localhost" };
}
