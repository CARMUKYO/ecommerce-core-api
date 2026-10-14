import { z } from "zod";

export const OrderIdParamSchema = z.object({
  id: z.string().uuid("Invalid order ID format; expected UUID"),
});

export const ListOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;
