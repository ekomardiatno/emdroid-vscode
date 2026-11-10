import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** Reports build results in a format the VS Code problem matcher understands. */
const report = (name) => ({
  name: 'report',
  setup(b) {
    b.onEnd((result) => {
      for (const e of result.errors) {
        const l = e.location;
        console.error(l ? `${l.file}:${l.line}:${l.column}: error: ${e.text}` : `error: ${e.text}`);
      }
      console.log(`[${name}] build ${result.errors.length ? 'failed' : 'ok'}`);
    });
  },
});

/**
 * Two bundles, two platforms. The host must be CJS because the extension host
 * loads `main` with require(); the webview must be ESM because it is loaded with
 * <script type="module">.
 */
const configs = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    // `vscode` is injected by the extension host. The other two are optional
    // native speedups `ws` requires() in a try/catch -- bundling them would
    // make esbuild fail on a missing module.
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
    plugins: [report('host')],
  },
  {
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    plugins: [report('webview')],
  },
  {
    entryPoints: ['src/webview/style.css'],
    outfile: 'dist/webview.css',
    plugins: [report('css')],
  },
];

const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'silent',
  legalComments: 'none',
};

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => context({ ...common, ...c })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('[watch] watching');
} else {
  const results = await Promise.allSettled(configs.map((c) => build({ ...common, ...c })));
  if (results.some((r) => r.status === 'rejected')) process.exit(1);
}
