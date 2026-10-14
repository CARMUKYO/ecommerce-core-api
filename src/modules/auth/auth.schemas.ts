import { z } from "zod";

const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Email cannot exceed 254 characters")
  .pipe(z.email("Invalid email address"));

// NIST SP 800-63B: length over composition rules. The upper bound caps the
// cost of hashing attacker-supplied input.
export const RegisterSchema = z.object({
  email: EmailSchema,
  password: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(128, "Password cannot exceed 128 characters"),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;

// Login does not re-validate password policy (that would leak the policy per
// account and break if the policy changes); it only bounds input size.
export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(128),
});

export type LoginInput = z.infer<typeof LoginSchema>;
