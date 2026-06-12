import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = "https://www.multimira.ai";

  return [
    {
      url: baseUrl,
      lastModified: new Date("2026-04-01"),
      changeFrequency: "weekly",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/changelog`,
      lastModified: new Date("2026-04-01"),
      changeFrequency: "weekly",
      priority: 0.6,
    },
  ];
}
