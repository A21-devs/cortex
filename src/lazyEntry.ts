/**
 * The lazy chunk's entry (built to its own bundle and embedded in main.js as a string; see scripts/build.mjs).
 * Everything heavy lives behind it: the service containers, command runner, Preact UI, three.js renderer, worker
 * source and modals. main.js stays small enough to compile and evaluate inside the load budget. Owner: E1.
 */
export * as container from "./plugin/container";
export * as commandRun from "./plugin/commandRun";
export * as mount from "./ui/mount";
