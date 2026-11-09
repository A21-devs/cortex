/**
 * Per-device hint and checklist state as a signal (CORTEX-UX §5.28): loaded once from
 * `app.loadLocalStorage("cortex:hints")` (parsed defensively by ui/deviceState.ts), saved on every change.
 * Per device and never synced: the same vault on another computer shows its own hints. A storage failure
 * (quota, private mode) keeps the in-memory state, so hints never reappear within the session. Owner: E1.
 */
import type { App } from "obsidian";
import { signal } from "@preact/signals-core";
import { emptyDeviceState, loadDeviceState, saveDeviceState, type DeviceState } from "../ui/deviceState";
import type { DeviceHandle } from "./services";

type LocalStorageApp = Pick<App, "loadLocalStorage" | "saveLocalStorage">;

export function createDeviceHandle(app: LocalStorageApp, onError?: (e: unknown) => void): DeviceHandle {
  let initial: DeviceState;
  try {
    initial = loadDeviceState(app);
  } catch (e) {
    onError?.(e);
    initial = emptyDeviceState();
  }
  const state = signal<DeviceState>(initial);
  return {
    get value() {
      return state.value;
    },
    signal: state,
    update(fn) {
      const next = fn(state.value);
      if (next === state.value) return;
      state.value = next;
      try {
        saveDeviceState(app, next);
      } catch (e) {
        onError?.(e);
      }
    },
  };
}
