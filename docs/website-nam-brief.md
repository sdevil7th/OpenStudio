# Website NAM Rack Design-First Prompt

Copy the prompt below into the `openstudio-website` repository.

---

Audit this repository and its local website/blog guidelines before proposing
anything. I want to add OpenStudio's NAM Rack to the homepage and Features page,
refresh relevant SEO, and prepare the existing NAM Rack blog for publication.

This is an approval-gated, two-phase task.

## Phase 1 — design only

Do not edit production code, copy assets, or publish the draft in this phase.

1. Run and inspect the current site at desktop, laptop, tablet, and mobile
   widths.
2. Read the existing component, data, class, animation, SEO, screenshot, and
   blog patterns. Identify exactly what can be reused.
3. Produce an annotated design for:
   - a concise homepage NAM Rack proof/feature section;
   - a full NAM Rack chapter on `/features`;
   - the NAM blog card/article presentation;
   - a factual comparison block for OpenStudio NAM Rack, AmpliTube 5, Guitar
     Rig 7, and Neural DSP plug-ins.
4. Use the real assets already present:
   - `/assets/blogs/building-openstudio-nam-rack.webp` for the three-screen
     amp + pre-FX pedals + post-FX pedals hero;
   - `/assets/blogs/building-openstudio-nam-rack-ui.webp` for the detailed amp
     UI.
   A complete set of real 1920x1080 product screenshots is also available at
   `C:\Users\srvds\OneDrive\Pictures\OpenStudio assets\TONE3000 review screenshots`.
   Inspect these during design, but do not copy any into the website until I
   approve both the layout and the selected images. The most useful files are:
   - `02-pre-fx-pedals.png`;
   - `03-a1-a2-amp-capture.png`;
   - `04-cabinet-ir.png`;
   - `05-parametric-eq.png`;
   - `06-post-fx-pedals.png`;
   - `07-signal-chain.png`;
   - `08-tone3000-capture-browser.png`;
   - `09-tone3000-audition.png`;
   - `11-input-calibration.png`;
   - `12-preset-library.png`.
   Do not invent a DJ, performer, cabinet screen, fake product UI, or fake
   hardware. If another screenshot is required, first specify the exact app
   state and crop needed.
5. Maintain the current visual language, spacing, type, motion restraint, and
   responsive behavior. Prefer existing components, data-driven rendering, and
   existing CSS classes. Propose a new primitive only if no current primitive
   fits.
6. Present the proposed hierarchy, copy, desktop/mobile wireframes or mockups,
   asset placement, reused components/classes, accessibility behavior, and
   implementation file list.
7. Stop and ask me to approve or revise the design. Do not implement until I
   explicitly approve it.

## Messaging direction

Lead with the outcome for guitarists:

> OpenStudio now has a free, built-in guitar rig powered by Neural Amp Modeler,
> with TONE3000 discovery, native pedals, cabinet IRs, and studio effects
> inside the DAW.

Make "free and open source" highly visible, but stay accurate:

- OpenStudio itself is free and open source with no paid NAM Rack tier.
- NAM A1/A2 support, the native pedalboard, cabinet stage, EQ, modulation,
  delay, reverb, shimmer, presets, and DAW recall are part of OpenStudio.
- Third-party capture and IR licenses still apply.
- A TONE3000 account is required for authenticated TONE3000 delivery.
- TONE3000's current free API tier permits OAuth prompt flows and bounded list
  endpoints. Do not promise richer catalog search until TONE3000 confirms that
  endpoint scope for OpenStudio in writing.
- Do not claim an automated test proves that OpenStudio sounds better than a
  commercial suite.

The confident comparison is that OpenStudio is a free, open-source alternative
in the same creative category as AmpliTube, Guitar Rig, and Neural DSP:
high-quality captured amp tones plus a complete recording/mixing context. Say
that A2 raises the possible tone ceiling and brings modern open NAM captures
into serious commercial-product territory, while making it clear that the
capture, calibration, cabinet, and player determine the final result.

The homepage section should be short and emotionally direct. The Features
chapter can go deeper into:

- A1 and A2 amp/full-rig capture support;
- the hardware-style native pedalboard;
- amp-only versus full-rig cabinet behavior;
- local IRs and cabinet shaping;
- calibration, model sample-rate handling, fixed latency, safe model/IR swaps,
  presets, A/B, project restore, and offline render;
- optional TONE3000 sign-up/sign-in, search, preview, install, attribution,
  recovery, and re-download;
- the benefit of doing all of this inside the same DAW project.

The first design proposal must show exactly which screenshot is used in each
section and why. Do not turn the Features page into a screenshot gallery; use
the smallest set that clearly explains the rack, its before/amp/after signal
flow, and TONE3000 access.

Use the corrected current signal path. Do not market active Pedal NAM
processing, live Transpose, Chaos mode, Glitch, or Doubler.

## Comparison block

Create a fair, compact table inspired by the
`debpalash/OmniVoice-Studio` README comparison style. Compare:

- product shape;
- base cost and free-tier limitations;
- open-source status;
- native NAM A1/A2 support;
- local/custom capture and IR workflow;
- included pedals/effects;
- full DAW recording, arranging, mixing, automation, and render;
- account/activation model;
- where each commercial product still wins.

Use current official primary sources. AmpliTube CS and Guitar Rig Player have
free editions, so do not imply that OpenStudio is the only product with any
free offering. Distinguish a limited free edition or trial from OpenStudio's
free, open-source full rack/DAW. Treat Neural DSP as a family of paid plug-ins
with trial availability, not one monolithic product. Use trademarks only for
truthful nominative comparison and do not imply affiliation.

## SEO and metadata

Reuse the existing `PageSeo` and route metadata pipeline. Propose updates for
the homepage, Features page, and blog article:

- precise titles and descriptions;
- canonical URLs;
- Open Graph/Twitter image and descriptive alt text;
- the existing `SoftwareApplication` JSON-LD `featureList`;
- article JSON-LD for the blog;
- natural visible headings and internal links;
- keyword arrays including variations such as:
  - free guitar amp simulator;
  - free guitar rig;
  - open-source amp simulator;
  - NAM A2 player;
  - Neural Amp Modeler DAW;
  - AmpliTube alternative;
  - Guitar Rig alternative;
  - Neural DSP alternative;
  - free amp capture software;
  - TONE3000 integration.

Do not keyword-stuff, create doorway copy, put competitor names into OpenStudio's
product name, or add unsupported review/rating schema. Meta keywords alone are
not the strategy; the visible comparison copy, title/description, internal
links, image metadata, and truthful structured data must agree.

## Blog direction

Keep the draft human, first-person, and developer-authored. Replace generic
phrasing with a stronger free/A2 opening. Explain why A2 can produce genuinely
high-end tones, why the whole signal chain matters, and how OpenStudio competes
with commercial guitar suites without making an unverified sound-quality
guarantee. Thank Steve Atkinson, the Neural Amp Modeler contributors, the
TONE3000 team, and capture creators.

Keep the post in `blogs/drafts/` until I explicitly approve publication.

## Phase 2 — only after my approval

Implement the approved design with the smallest reasonable diff:

1. Reuse existing components, data structures, utilities, animations, and CSS
   classes.
2. Keep content data-driven in the same files/patterns already used by Home and
   Features.
3. Preserve accessibility, reduced-motion behavior, lazy image loading, and
   responsive layout.
4. Update SEO and route-prerender metadata consistently.
5. Update the blog image manifest through the existing script rather than by
   hand.
6. Run lint/type checks, tests, the production build, metadata prerendering,
   and visual checks at all supported widths.
7. Show the final screenshots and list every changed file. Do not deploy or
   publish the blog unless I separately ask.

Before beginning Phase 2, restate the exact design I approved and wait if any
part of that approval is ambiguous.

---
