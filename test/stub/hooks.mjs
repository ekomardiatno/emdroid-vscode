/**
 * Resolve hooks that make `src/` importable by `node --test`.
 *
 * Two rewrites, both needed only under test:
 *
 *  - **`vscode`** is injected by the extension host and has no npm package, so
 *    without a double `StreamServer` and `MirrorSession` -- the two pieces the
 *    whole transport rests on -- could only be exercised in a live editor.
 *  - **`./x.js` -> `./x.ts`**: the host bundle is type-checked under Node16
 *    module resolution, which requires the `.js` extension on relative
 *    specifiers even though the files are `.ts`. esbuild resolves that at build
 *    time; node's type stripping does not.
 */
const stub = new URL('./vscode.ts', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === 'vscode') return { url: stub, shortCircuit: true };

  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
      return next(`${specifier.slice(0, -'.js'.length)}.ts`, context);
    }
    throw err;
  }
}
