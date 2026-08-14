import { z } from "zod";

export const PersonalAccessTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  token_prefix: z.string(),
  expires_at: z.string().nullable(),
  last_used_at: z.string().nullable(),
  created_at: z.string(),
});

export const PersonalAccessTokenListSchema = z.array(PersonalAccessTokenSchema);

export const PersonalAccessTokenResponseSchema = PersonalAccessTokenSchema.extend({
  token: z.string(),
});

export const EMPTY_PERSONAL_ACCESS_TOKEN = {
  id: "",
  name: "",
  token_prefix: "",
  expires_at: null,
  last_used_at: null,
  created_at: "",
  token: "",
};
