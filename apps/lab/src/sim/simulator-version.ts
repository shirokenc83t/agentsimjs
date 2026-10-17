// Replaced at build time by the Vite `define` (see ../../simulator-version.ts); absent under plain Vitest.
declare const __SIMULATOR_VERSION__: string | undefined;

/** `<version>+<commit>[-dirty]` of this build, recorded in every run header and export (ADR-0028). */
export const SIMULATOR_VERSION: string = typeof __SIMULATOR_VERSION__ === "string" ? __SIMULATOR_VERSION__ : "0.0.0+unknown";
