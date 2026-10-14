import { z } from "zod";

export const OrderIdParamSchema = z.object({
  id: z.string().uuid("Invalid order ID format; expected UUID"),
});

export const ListOrdersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

export const AdminListOrdersQuerySchema = ListOrdersQuerySchema.extend({
  status: z.enum(["PENDING", "PAID", "SHIPPED", "CANCELLED"]).optional(),
  userId: z.string().uuid("Invalid user ID format; expected UUID").optional(),
});
