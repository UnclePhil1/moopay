import { z } from "zod";

/*
 * Shapes of what is kept on disk and what arrives over HTTP. Stored records stay tolerant (passthrough, most fields optional):
 * a file written by an older release must still load, and a record that does not load is refused rather than rewritten.
 */
const looseRecord = z.object({}).passthrough();
const day = z.object({ day: z.string(), usd: z.number() });

export const UserFileSchema = z.object({
  users: z.array(z.object({
    id: z.string().min(1),
    accountId: z.string().min(1),
    rules: looseRecord,
    spent: day.optional(),
    known: z.array(z.string()).optional(),
    payments: z.array(looseRecord).optional(),
    approvals: z.array(looseRecord).optional(),
    tasks: z.array(looseRecord).optional(),
    events: z.array(looseRecord).optional(),
    chat: z.array(looseRecord).optional(),
  }).passthrough()),
  /** every payment ever made, kept after it drops out of a user's recent list, and the most each wallet has held */
  ledger: z.record(z.string(), looseRecord).optional(),
  peaks: z.record(z.string(), z.number()).optional(),
});

export const ClaimFileSchema = z.object({
  claims: z.array(z.object({
    fundKey: z.string().min(1),
    claimKey: z.string().min(1),
    receiver: z.string().min(1),
    noteAccountId: z.string().min(1),
    state: z.enum(["AWAITING_FUNDING", "FUNDED", "CLAIMING", "CLAIMED", "REFUNDED", "CANCELLED"]),
    amount: z.string(),
    createdAt: z.number(),
    token: looseRecord,
  }).passthrough()).default([]),
});

export const LedgerFileSchema = z.object({
  version: z.literal(1),
  notes: z.record(z.string(), z.object({ commitment: z.string(), amount: z.string() }).passthrough()).default({}),
  nullifiers: z.record(z.string(), z.object({ state: z.enum(["UNUSED", "CLAIMING", "SPENT"]), commitment: z.string() })).default({}),
});

export const StatsFileSchema = z.object({
  payments: z.number().default(0),
  volumeUsdCents: z.number().default(0),
  wallets: z.array(z.string()).default([]),
  seen: z.array(z.string()).default([]),
});

/** A payment the pay page sends back: transaction hash, payout wallet, or the asset a payer chose. */
export const TxBody = z.object({ tx: z.string().max(2048).default("") });
export const PayoutBody = z.object({ address: z.string().trim().max(128).default("") });
export const QuoteBody = z.object({ originAssetId: z.string().min(1).max(256), refundTo: z.string().max(256) });

export const FundPlanBody = z.object({ sender: z.string().min(1).max(256) });
export const ClaimBody = z.object({ accountId: z.string().min(1).max(256), publicKey: z.string().max(256).optional(), signature: z.string().min(1).max(1024) });

export type UserFile = z.infer<typeof UserFileSchema>;
export type StatsFile = z.infer<typeof StatsFileSchema>;
