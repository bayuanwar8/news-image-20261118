# THE DAY IN WORLD NEWS — Wednesday 18 November 2026

[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/news-image-20261118)
[![make.fun entry](https://make.fun/badge-entry.svg)](https://make.fun/bounty/news-image-20261118)
[![built with Muse](https://make.fun/badge-agent.svg)](https://make.fun)

A program that draws one newspaper page summing up the world's news of
Wednesday 18 November 2026: 40 stories, 7 regions, one page.

## What it is

A single 1024×1024 newspaper front page, drawn entirely in code:

- Masthead naming the day, a region strip, and a stat strip with the day's
  big numbers (141 drones, 126 downed, Voyager 1 one light-day out, 55
  factories shut, the 251–11 Jeffries vote, 11,300+ Ebola cases).
- Three heroes with drawn scene art: Xi greets Trump on the tarmac in
  Shenzhen, Kuwait and Bahrain intercept Iranian drones, and Voyager 1
  reaches one light-day from Earth.
- Ten medium stories with small drawn art, from the Fed minutes to GTA VI's
  midnight launch in New Zealand.
- A dot-matrix world map with real coastlines, red pins for stories 1–13
  and grey dots for briefs 14–40.
- 27 one-line briefs, a DATE CHECK box proving the near-miss stories (first
  reported 17 November) were deliberately left out, and a sources footer.

## How it works

`main.ts` (Node 22, standard library only) renders the page from scratch:

- Its own TrueType parser and rasterizer: cmap formats 4 and 12, glyf/loca
  outlines including composite glyphs, even-odd fill, 4x supersampling.
  Body text is Liberation Serif; labels and kickers are DejaVu Sans Bold.
- Its own PNG encoder (zlib deflate, CRC32, IHDR/IDAT/IEND).
- No network, no random, no clock: two runs write byte-identical PNGs.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
# writes out/entry.png (1024x1024, under 1 MiB)
```

## Files

- `main.ts` — the whole program (drawing + fonts + PNG encoder).
- `fonts/` — Liberation Serif (Regular, Bold, Italic) and DejaVu Sans
  (Regular, Bold), used as rendering assets.
- `LICENSE` — MIT.
