import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/* Loads app .ts/.tsx modules (and their relative imports) for server-side render
   tests without a bundler: TypeScript transpiles each file to CommonJS, CSS imports
   become empty objects, packages come from node_modules, and `stubs` replace
   modules by repository-relative path (e.g. "app/lib/auth.tsx"). One cache per
   loader keeps React contexts shared between the modules it loads. */

const websiteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requirePackage = createRequire(resolve(websiteRoot, "package.json"));

export function createTsxLoader(stubs: Record<string, unknown> = {}) {
  const cache = new Map<string, Record<string, unknown>>();

  function resolveFile(fromFile: string, specifier: string): string {
    const base = resolve(dirname(fromFile), specifier);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
      if (existsSync(candidate) && !candidate.endsWith("/")) return candidate;
    }
    throw new Error(`Cannot resolve ${specifier} from ${fromFile}`);
  }

  function load(file: string): Record<string, unknown> {
    const relative = file.slice(websiteRoot.length + 1);
    if (relative in stubs) return stubs[relative] as Record<string, unknown>;
    const cached = cache.get(file);
    if (cached !== undefined) return cached;
    const module = { exports: {} as Record<string, unknown> };
    cache.set(file, module.exports);
    const output = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: file,
    }).outputText;
    Function("require", "module", "exports", output)(
      (specifier: string) => {
        if (specifier.endsWith(".css")) return {};
        if (specifier.startsWith(".")) return load(resolveFile(file, specifier));
        return requirePackage(specifier);
      },
      module,
      module.exports,
    );
    cache.set(file, module.exports);
    return module.exports;
  }

  return {
    load: (repositoryRelativePath: string) => load(resolve(websiteRoot, repositoryRelativePath)),
    requirePackage,
  };
}
