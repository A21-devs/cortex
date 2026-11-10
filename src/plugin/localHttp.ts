/**
 * The HTTP seam for the settings "Test" button (P20): Obsidian's `requestUrl`, which is not subject to the
 * browser's cross-origin rules, so a model server that does not send CORS headers still answers. Only the address
 * the person configured is ever passed in (shared/localModel.ts checks it first).
 */
import { requestUrl } from "obsidian";
import { LocalHttpError, type LocalHttp } from "../shared/localModel";

export const obsidianHttp: LocalHttp = async (req) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LocalHttpError("timeout")), Math.max(1, req.timeoutMs));
  });
  try {
    const call = requestUrl({ url: req.url, method: req.method, ...(req.body !== undefined ? { body: req.body, contentType: "application/json" } : {}), throw: false });
    const res = await Promise.race([call, timeout]);
    return { status: res.status, text: res.text };
  } catch (e) {
    if (e instanceof LocalHttpError) throw e;
    throw new LocalHttpError("network");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
