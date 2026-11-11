import { describe, expect, it } from "vitest";
import { ROUTE_VIEWS } from "../src/shared/views";
import { timeTab } from "../src/ui/pages/Time";

describe("Time tabs", () => {
  it("opens on the charts; the spine keeps its old param", () => {
    expect(timeTab(undefined)).toBe("charts");
    expect(timeTab("charts")).toBe("charts");
    expect(timeTab("figure")).toBe("figure");
    expect(timeTab("spine")).toBe("figure");
    expect(timeTab("data")).toBe("data");
    expect(timeTab("nonsense")).toBe("charts");
  });
  it("names Charts first in the route views", () => {
    expect(ROUTE_VIEWS.time[0]).toBe("charts");
  });
});
