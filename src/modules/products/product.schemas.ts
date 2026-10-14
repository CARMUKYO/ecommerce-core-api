import { z } from "zod";

export const CreateProductSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(1, "SKU is required")
    .max(64, "SKU cannot exceed 64 characters")
    .regex(/^[a-zA-Z0-9_-]+$/, "SKU must contain only alphanumeric characters, underscores, or hyphens"),
  name: z.string().trim().min(1, "Product name cannot be empty").max(255, "Product name cannot exceed 255 characters"),
  description: z.string().max(2000, "Description cannot exceed 2000 characters").default(""),
  priceCents: z
    .number({ message: "priceCents must be a valid integer" })
    .int("priceCents must be an integer representing minor units")
    .min(0, "priceCents cannot be negative")
    .max(99_999_999, "priceCents cannot exceed 99,999,999"),
  currency: z.literal("USD").default("USD"),
  initialStock: z
    .number({ message: "initialStock must be an integer" })
    .int("initialStock must be an integer")
    .min(0, "initialStock cannot be negative")
    .max(1_000_000, "initialStock cannot exceed 1,000,000")
    .default(0),
});

export type CreateProductInput = z.infer<typeof CreateProductSchema>;

export const UpdateProductSchema = z
  .object({
    name: z.string().trim().min(1, "Product name cannot be empty").max(255).optional(),
    description: z.string().max(2000).optional(),
    priceCents: z
      .number({ message: "priceCents must be an integer" })
      .int("priceCents must be an integer representing minor units")
      .min(0, "priceCents cannot be negative")
      .max(99_999_999, "priceCents cannot exceed 99,999,999")
      .optional(),
    sku: z
      .string()
      .trim()
      .min(1, "SKU cannot be empty")
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/, "SKU must contain only alphanumeric characters, underscores, or hyphens")
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update",
  });

export type UpdateProductInput = z.infer<typeof UpdateProductSchema>;

export const ProductIdParamSchema = z.object({
  id: z.string().uuid("Invalid product ID format; expected UUID"),
});

export const ListProductsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
});

export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;
