// The page of the fixtures (fixtures/index.html) exposes the module's open() to the tests.
export {};

declare global {
  interface Window {
    // the page API of the module, called from evaluated strings: its type is the module's, not checked here
    openDb: (options?: Record<string, unknown>) => Promise<any>; // oxlint-disable-line typescript/no-explicit-any
  }
}
