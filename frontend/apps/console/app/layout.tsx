import type { Metadata, Viewport } from "next";
import { Inter, Geist_Mono, Source_Serif_4 } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@multiremi/ui/components/ui/sonner";
import { cn } from "@multiremi/ui/lib/utils";
import { WebProviders } from "@/components/web-providers";
import type { SupportedLocale } from "@multiremi/core/i18n";
import { RESOURCES } from "@multiremi/views/locales";
import { getRequestLocale } from "@/lib/request-locale";
import "./globals.css";

// Inter is the Latin UI face. next/font produces a hashed family (`__Inter_xxx`)
// plus a synthetic size-adjusted fallback face to prevent FOUT layout shift —
// both are exposed under the `--font-inter` CSS variable.
//
// The full `--font-sans` stack (Inter + the per-locale CJK fallback chain) is
// assembled in static CSS in ./globals.css, not here: it must be overridable per
// `<html lang>` (Japanese Kanji are Han ideographs and need a Japanese-first CJK
// stack), and a hashed family name can only be referenced from CSS via a variable.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  fallback: [
    "ui-serif",
    "Iowan Old Style",
    "Apple Garamond",
    "Baskerville",
    "Times New Roman",
    "serif",
  ],
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#05070b" },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000"),
  title: {
    default: "Remi Console",
    template: "%s | Remi Console",
  },
  description:
    "Unified console for the Remi admin (后台) and the Multiremi board (看板).",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml" }],
    shortcut: ["/favicon.svg"],
  },
  robots: {
    index: false,
    follow: false,
  },
};

// HTML lang attribute uses BCP-47 region tags that screen readers and font
// stacks recognize widely. i18next keeps `zh-Hans` as its internal locale
// (script subtag is what we actually translate against), but the html element
// expects a region-flavoured tag for accessibility tooling and CJK fallback.
const HTML_LANG: Record<SupportedLocale, string> = {
  en: "en",
  "zh-Hans": "zh-CN",
  ko: "ko-KR",
  ja: "ja-JP",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getRequestLocale();
  const resources = { [locale]: RESOURCES[locale] };

  return (
    <html
      lang={HTML_LANG[locale]}
      suppressHydrationWarning
      className={cn("antialiased font-sans h-full", inter.variable, geistMono.variable, sourceSerif.variable)}
    >
      <body className="h-full overflow-hidden">
        <ThemeProvider>
          <WebProviders locale={locale} resources={resources}>
            {children}
          </WebProviders>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
