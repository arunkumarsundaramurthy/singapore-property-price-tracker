import { z } from 'zod';

const opt = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);

export const NormalizedListingSchema = z.object({
  source_listing_id: z.string().min(1),
  listing_type: z.enum(['sale', 'rent']),
  property_type: z.enum(['hdb', 'condo', 'apartment', 'ec', 'landed', 'other']),
  title: opt(z.string()),
  project_name: opt(z.string()),
  address: opt(z.string()),
  postal_code: opt(z.string()),
  district: opt(z.string()),
  bedrooms: opt(z.number().int().min(0)),
  bathrooms: opt(z.number().int().min(0)),
  floor_area_sqft: opt(z.number().positive()),
  price: z.number().positive(),
  tenure: opt(z.string()),
  built_year: opt(z.number().int()),
  lat: opt(z.number()),
  lng: opt(z.number()),
  url: z.string().min(1),
  extra: z.record(z.string(), z.unknown()).default({}),
});

export type NormalizedListing = z.output<typeof NormalizedListingSchema>;
