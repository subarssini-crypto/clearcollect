// Test-only module hooks: resolves the "@/..." tsconfig alias and the
// extensionless relative imports used by src/ and the generated Prisma client.
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);
