declare module "bun:test" {
  type VoidOrPromise = void | Promise<void>;
  type TestFn = () => VoidOrPromise;
  type HookFn = TestFn;
  interface Expectation {
    toBeDefined(): void;
    toBeGreaterThan(value: number): void;
    toBeLessThan(value: number): void;
    toContain(value: string): void;
    toBe(value: number): void;
  }
  function describe(name: string, fn: () => void): void;
  function it(name: string, fn: TestFn): void;
  function expect(value: unknown): Expectation;
  function beforeEach(fn: HookFn): void;
  function afterEach(fn: HookFn): void;
}
