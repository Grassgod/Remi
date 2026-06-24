import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Remi Console",
  description: "Unified entry for the Remi 后台 (admin) and Multiremi 看板.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
