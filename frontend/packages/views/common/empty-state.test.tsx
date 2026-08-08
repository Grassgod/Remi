import { render, screen } from "@testing-library/react";
import { AlertCircle, Bot } from "lucide-react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders the media variant as a level-2 heading with a circled icon", () => {
    const { container } = render(
      <EmptyState
        icon={Bot}
        title="No agents yet"
        description="Create one to get started"
        action={<button type="button">New agent</button>}
      />
    );

    // The fourteen migrated call sites all rendered an <h2>; the shared
    // component keeps that role even though the primitive emits a <div>.
    expect(
      screen.getByRole("heading", { level: 2, name: "No agents yet" })
    ).toBeInTheDocument();
    expect(screen.getByText("Create one to get started")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New agent" })
    ).toBeInTheDocument();

    const media = container.querySelector('[data-slot="empty-icon"]');
    expect(media?.className).toContain("rounded-full");
    expect(media?.className).toContain("h-12");
    expect(media?.querySelector("svg")?.getAttribute("class")).toContain(
      "h-6 w-6 text-muted-foreground"
    );
  });

  it("renders the status variant without a heading and tints the icon", () => {
    const { container } = render(
      <EmptyState
        variant="status"
        tone="destructive"
        icon={AlertCircle}
        title="Could not load"
        description="Network unreachable"
      />
    );

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText("Could not load")).toBeInTheDocument();

    const media = container.querySelector('[data-slot="empty-icon"]');
    expect(media?.className).not.toContain("rounded-full");
    expect(media?.querySelector("svg")?.getAttribute("class")).toContain(
      "text-destructive"
    );
  });

  it("defaults the status icon to the muted tone", () => {
    const { container } = render(
      <EmptyState variant="status" icon={AlertCircle} title="Not found" />
    );

    const svg = container.querySelector('[data-slot="empty-icon"] svg');
    expect(svg?.getAttribute("class")).toContain("text-muted-foreground");
    expect(svg?.getAttribute("class")).not.toContain("text-destructive");
  });

  it("omits the description node entirely when none is given", () => {
    const { container } = render(<EmptyState icon={Bot} title="Nothing" />);

    expect(
      container.querySelector('[data-slot="empty-description"]')
    ).toBeNull();
  });

  it("keeps the migrated layout classes and lets callers override them", () => {
    const { container } = render(
      <EmptyState className="flex-initial" icon={Bot} title="Nothing" />
    );

    const root = container.querySelector('[data-slot="empty"]');
    expect(root?.className).toContain("px-6");
    expect(root?.className).toContain("py-16");
    expect(root?.className).toContain("text-center");
    // `Empty` ships `flex-1`; the inbox list column needs it dropped.
    expect(root?.className).toContain("flex-initial");
    expect(root?.className).not.toContain("flex-1");
  });
});
