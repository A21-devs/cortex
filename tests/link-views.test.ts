/** More › Link views: linked leaves follow each other's scope, period and tokens (CORTEX-UX §2.4). */
import { describe, expect, it } from "vitest";
import { bindLink, isLinked, setLinked } from "../src/ui/header/MoreMenu";
import { setScope } from "../src/state/actions";
import { fakeServices } from "./helpers/fakeServices";

describe("link views", () => {
  it("keeps linked leaves in step, and an unlinked or disposed leaf out of it", () => {
    const h = fakeServices();
    const a = h.leaf;
    const b = h.services.createLeaf("leaf-b");
    const offA = bindLink(h.services, a);
    const offB = bindLink(h.services, b);
    setScope(a.store, "code");
    expect(b.store.get("ui").scope).not.toBe("code"); // not linked yet
    setLinked(h.services, a, true);
    setLinked(h.services, b, true);
    expect(isLinked(h.services, b)).toBe(true);
    expect(b.store.get("ui").scope).toBe("code"); // joining adopts the linked leaf's state
    setScope(b.store, "web");
    expect(a.store.get("ui").scope).toBe("web");
    setScope(a.store, "all");
    expect(b.store.get("ui").scope).toBe("all");
    offB(); // closing a leaf unlinks it
    expect(isLinked(h.services, b)).toBe(false);
    setScope(a.store, "code");
    expect(b.store.get("ui").scope).toBe("all");
    offA();
  });
});
