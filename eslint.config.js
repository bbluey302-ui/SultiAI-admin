// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // `dist/*` is build output.
    //
    // `supabase/functions/**` runs on Deno, not Node, so the import resolver
    // used here cannot verify its specifiers: `npm:@supabase/server@1.9.1` is a
    // Deno-only form and the shared modules import each other with explicit
    // `.ts` extensions. Both resolve correctly in the edge runtime, so
    // flagging them here would be a false positive on every function file.
    // They are type-checked and bundled by `supabase functions deploy`.
    ignores: ["dist/*", "supabase/functions/**"],
  }
]);
