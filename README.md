# site2video

Generate a short "live demo" video of any website: the page loads, holds on the hero, then smoothly scrolls down — optionally continuing through several subpages for a full site tour. Output is a horizontal (16:9) or vertical (9:16) MP4 ready for social.

URLs can be passed bare (`site2video stripe.com`) — `https://` is assumed.

## Install

### Homebrew (macOS / Linux)

```bash
brew tap TheQuietG/tap
brew install site2video
```

Playwright's Chromium is downloaded automatically after install.

### From source

```bash
git clone https://github.com/TheQuietG/site2video
cd site2video
npm install
npx playwright install chromium
npm link   # makes `site2video` available globally
```

ffmpeg is bundled via `ffmpeg-static` — no system install needed.

## Usage

```bash
site2video <url> [options]
site2video --help
site2video --version
```

The video is written to the directory you run the command from (or wherever `-o` points).

### Options

| Option | Description | Default |
| --- | --- | --- |
| `-o, --output <file>` | Output path | `./<hostname>-<orientation>.mp4` |
| `--orientation <o>` | `horizontal` (1920×1080) or `vertical` (1080×1920) | `horizontal` |
| `--style <s>` | Vertical only: `mobile` (responsive mobile layout) or `framed` (desktop view on a blurred 9:16 canvas) | `mobile` |
| `--pages <n>` | Pages to feature (1–8): homepage plus subpages auto-discovered from the site's nav (login/cart/legal links are skipped) | `1` |
| `--duration <sec>` | Total video length target, split across pages | `12`, or `8` per page |
| `--hold <sec>` | Hold time on the hero before scrolling | `2.5` |
| `--fps <n>` | Output frame rate (5–60) | `30` |
| `--quality <q>` | `low`, `medium`, or `high` (h264 CRF 28/23/18) | `high` |

### Examples

```bash
# Horizontal desktop demo (1920×1080)
site2video https://vercel.com

# Vertical, using the site's mobile layout (1080×1920)
site2video https://vercel.com --orientation vertical --style mobile

# Vertical, desktop layout framed on a blurred background
site2video https://vercel.com --orientation vertical --style framed -o demo.mp4

# Longer video with a longer hero hold
site2video https://example.com --duration 20 --hold 4

# Multi-page demo: homepage plus two subpages from the site's nav (~24s)
site2video https://example.com --pages 3
```

## How it works

1. **Record** (`src/record.js`) — Playwright launches headless Chromium at the right viewport for the mode, loads the page, and auto-dismisses common cookie/consent banners (OneTrust, Cookiebot, Didomi, Usercentrics, Quantcast, and a generic "Accept all"/"Reject all"-style text match, re-checked on every page in case a banner appears late). Capture then starts via CDP screencast: Chrome streams timestamped JPEG frames at 2× device pixels (so nothing that happened before — blank page, loading, banners — is ever in the video). Each page gets a hold at the top, an ease-in-out scroll toward the bottom (capped at 4 viewport-heights, forced `behavior: instant` per step so CSS `scroll-behavior: smooth` sites can't swallow it), and a settle at the end. With `--pages > 1` it then navigates to each auto-discovered subpage and repeats, with the real page-load transitions kept in the video; the CLI prints which pages were featured.
2. **Compose** (`src/compose.js`) — ffmpeg assembles the timestamped frames (via an ffconcat list, so variable capture timing becomes correct constant-frame-rate video) into an h264 MP4 at the final resolution and chosen fps/quality; `framed` mode builds a blurred/darkened fill background from the same footage and overlays the desktop view centered on it.

Google One Tap sign-in popups are blocked at the network level so they never appear in recordings.

## Limitations

- **Bot protection**: sites behind aggressive bot protection (e.g. Cloudflare) may serve a "verify you are human" challenge instead of the landing page — more likely after several runs in a row against the same site. The CLI detects this and prints a warning; wait a bit or try from a different network.
- **Cookie banners**: dismissal is best-effort — it covers the major consent managers and common button wording, but unusual custom banners may still appear.
- **Subpage discovery** (`--pages`): links come from the site's own nav; if fewer usable links exist than requested, the video covers what was found and the CLI warns. There is no flag yet to hand-pick the subpages.
- **Password-protected sites** are not supported: the video shows whatever an anonymous visitor sees (usually the login screen).
