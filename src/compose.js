import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';

// ffmpeg-static's binary is fetched by its npm postinstall script, which some
// package managers (e.g. Homebrew's sandboxed build) skip — fall back to PATH.
const ffmpegPath = ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : 'ffmpeg';

export const QUALITY_CRF = { low: 28, medium: 23, high: 18 };

function fitFilter(width, height, fps) {
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`
  );
}

// Blurred, darkened fill of the same footage behind a centered, scaled-down desktop view.
function framedFilter(fps) {
  return (
    '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.08[bg];' +
    '[0:v]scale=1000:-2:flags=lanczos[fg];' +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${fps}[v]`
  );
}

/**
 * Assembles the captured frame sequence (ffconcat list of timestamped JPEGs)
 * into the final .mp4 for the requested orientation/style.
 * Returns the output path.
 */
export async function compose({ input, output, orientation, style, fps = 30, quality = 'high' }) {
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', input];

  if (orientation === 'vertical' && style === 'framed') {
    args.push('-filter_complex', framedFilter(fps), '-map', '[v]');
  } else if (orientation === 'vertical') {
    args.push('-vf', fitFilter(1080, 1920, fps));
  } else {
    args.push('-vf', fitFilter(1920, 1080, fps));
  }

  const crf = String(QUALITY_CRF[quality]);
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output);

  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => (stderr += chunk));
    proc.on('error', (err) =>
      reject(
        err.code === 'ENOENT'
          ? new Error('ffmpeg not found — install it with `brew install ffmpeg` (or reinstall this package so ffmpeg-static can fetch its binary).')
          : err,
      ),
    );
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}:\n${stderr.slice(-2000)}`));
    });
  });

  return output;
}
