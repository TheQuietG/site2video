#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { program } from 'commander';
import { record } from './record.js';
import { compose, QUALITY_CRF } from './compose.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

program
  .name('site2video')
  .description(pkg.description)
  .version(pkg.version, '-v, --version')
  .argument('<url>', 'website URL to record')
  .option('-o, --output <file>', 'output path (default: ./<hostname>-<orientation>.mp4)')
  .option('--orientation <o>', 'horizontal | vertical', 'horizontal')
  .option('--style <s>', 'vertical only: mobile | framed', 'mobile')
  .option('--pages <n>', 'number of pages to feature (homepage + auto-discovered subpages)', (v) => parseInt(v, 10), 1)
  .option('--duration <sec>', 'total video length target in seconds (default: 12, or 8 per page)', parseFloat)
  .option('--hold <sec>', 'hold time on hero before scrolling', parseFloat, 2.5)
  .option('--fps <n>', 'output frame rate', parseFloat, 30)
  .option('--quality <q>', 'low | medium | high', 'high')
  .action(async (url, opts) => {
    let parsed;
    try {
      parsed = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`);
    } catch {
      program.error(`Invalid URL: ${url}`);
    }
    if (!['horizontal', 'vertical'].includes(opts.orientation)) {
      program.error(`--orientation must be "horizontal" or "vertical", got "${opts.orientation}"`);
    }
    if (!['mobile', 'framed'].includes(opts.style)) {
      program.error(`--style must be "mobile" or "framed", got "${opts.style}"`);
    }
    if (!(opts.pages >= 1 && opts.pages <= 8)) {
      program.error(`--pages must be between 1 and 8, got "${opts.pages}"`);
    }
    opts.duration ??= opts.pages > 1 ? 8 * opts.pages : 12;
    if (!(opts.duration > 0) || !(opts.hold >= 0) || opts.hold >= opts.duration) {
      program.error('--duration must be > 0 and --hold must fit within it');
    }
    if (!(opts.fps >= 5 && opts.fps <= 60)) {
      program.error(`--fps must be between 5 and 60, got "${opts.fps}"`);
    }
    if (!(opts.quality in QUALITY_CRF)) {
      program.error(`--quality must be "low", "medium" or "high", got "${opts.quality}"`);
    }

    const output = resolve(
      opts.output ?? `${parsed.hostname.replace(/^www\./, '')}-${opts.orientation}.mp4`,
    );

    const videoDir = await mkdtemp(join(tmpdir(), 'site2video-'));
    try {
      console.log(`Recording ${parsed.href} (${opts.orientation}${opts.orientation === 'vertical' ? `, ${opts.style}` : ''})...`);
      const { concatFile, visited } = await record({
        url: parsed.href,
        orientation: opts.orientation,
        style: opts.style,
        duration: opts.duration,
        hold: opts.hold,
        pages: opts.pages,
        videoDir,
      });

      if (visited.length > 1) console.log(`Featured pages:\n${visited.map((v) => `  ${v}`).join('\n')}`);
      console.log('Encoding...');
      await compose({
        input: concatFile,
        output,
        orientation: opts.orientation,
        style: opts.style,
        fps: opts.fps,
        quality: opts.quality,
      });
      console.log(`Done: ${output}`);
    } finally {
      await rm(videoDir, { recursive: true, force: true });
    }
  });

program.parseAsync().catch((err) => {
  const message = err.message ?? String(err);
  console.error(message);
  if (/executable doesn't exist|please run the following command/i.test(message)) {
    console.error('\nChromium is not installed for Playwright. Install it with:\n  npx playwright install chromium');
  }
  process.exit(1);
});
