/** Tipos ambiente do Deno para o language server do editor (Cursor/VS Code).
 *  O mesmo papel de supabase/functions/deno.d.ts: o tsserver não vê o namespace do Deno.
 *  O `deno check` usa os tipos do próprio Deno e não depende deste arquivo.
 */
declare namespace Deno {
  interface Env {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
  }

  const env: Env;

  interface DirEntry {
    name: string;
    isFile: boolean;
    isDirectory: boolean;
  }

  function cwd(): string;
  function chdir(directory: string): void;
  function readTextFile(path: string | URL): Promise<string>;
  function writeTextFile(path: string | URL, data: string): Promise<void>;
  function readDir(path: string | URL): AsyncIterable<DirEntry>;
  function makeTempDir(options?: { prefix?: string; suffix?: string; dir?: string }): Promise<string>;
  function serve(
    handler: (request: Request) => Response | Promise<Response>,
  ): void;

  interface TestOptions {
    ignore?: boolean;
    sanitizeOps?: boolean;
    sanitizeResources?: boolean;
  }

  interface TestDefinition extends TestOptions {
    name: string;
    fn: () => void | Promise<void>;
  }

  function test(name: string, fn: () => void | Promise<void>): void;
  function test(name: string, options: TestOptions, fn: () => void | Promise<void>): void;
  function test(t: TestDefinition): void;
}

declare module "jsr:@std/assert@1" {
  export function assert(expr: unknown, msg?: string): asserts expr;
  export function assertEquals(actual: unknown, expected: unknown, msg?: string): void;
  export function assertRejects(
    fn: () => Promise<unknown>,
    errorClass?: new (...args: never[]) => Error,
    msgIncludes?: string,
  ): Promise<Error>;
  export function assertThrows(fn: () => unknown, ...rest: unknown[]): unknown;
  export function assertNotEquals(actual: unknown, expected: unknown, msg?: string): void;
  export function assertStringIncludes(actual: string, expected: string, msg?: string): void;
}

declare module "jsr:@std/assert" {
  export * from "jsr:@std/assert@1";
}
