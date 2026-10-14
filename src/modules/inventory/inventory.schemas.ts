import { z } from "zod";

export const AdjustInventorySchema = z.object({
  delta: z
    .number({ message: "delta must be an integer" })
    .int("delta must be an integer")
    .refine((n) => n !== 0, "delta cannot be 0")
    .min(-1_000_000, "delta cannot be less than -1,000,000")
    .max(1_000_000, "delta cannot exceed 1,000,000"),
  note: z
    .string()
    .trim()
    .min(1, "Adjustment note is required for the audit trail")
    .max(500, "Adjustment note cannot exceed 500 characters"),
});

export type AdjustInventoryInput = z.infer<typeof AdjustInventorySchema>;

export const ListMovementsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListMovementsQuery = z.infer<typeof ListMovementsQuerySchema>;
