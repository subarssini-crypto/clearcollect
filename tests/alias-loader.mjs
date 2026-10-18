import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const src = path.join(root, "src");

function findFile(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  let base = null;
  if (specifier.startsWith("@/")) {
    base = path.join(src, specifier.slice(2));
  } else if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith("file:")) {
    const parent = fileURLToPath(context.parentURL);
    if (!parent.includes(`${path.sep}node_modules${path.sep}`)) {
      base = path.resolve(path.dirname(parent), specifier);
    }
  }
  const file = base && findFile(base);
  return next(file ? pathToFileURL(file).href : specifier, context);
}
