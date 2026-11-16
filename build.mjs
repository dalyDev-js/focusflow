// Builds the extension into dist/ and packages it as site/focusflow-extension.zip.
import { build, context } from 'esbuild';
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const watch = process.argv.includes('--watch');
const options = {
  entryPoints: {
    background: 'src/background.ts',
    offscreen: 'src/offscreen.ts',
    'popup/popup': 'src/popup/popup.ts',
  },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
cpSync('static', 'dist', { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching src/ — load dist/ as an unpacked extension.');
} else {
  await build(options);
  // Zip dist/ as a folder named focusflow-extension for the download on the site.
  rmSync('build', { recursive: true, force: true });
  mkdirSync('build');
  cpSync('dist', 'build/focusflow-extension', { recursive: true });
  rmSync('site/focusflow-extension.zip', { force: true });
  execFileSync('zip', ['-qr', '../site/focusflow-extension.zip', 'focusflow-extension'], { cwd: 'build' });
  rmSync('build', { recursive: true, force: true });
  console.log('Packaged site/focusflow-extension.zip');
}
