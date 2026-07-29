# Structured Website Preview

This branch contains a generated, structured copy of the current Aircraft Tycoon website.

## Safety boundary

- The production `index.html` remains unchanged.
- The structured copy is available at `/preview/`.
- CSS, JavaScript and embedded images were externalised into `/assets/`.
- The official Steam widget for App ID `4997100` is included only in the structured preview.
- No custom Steam logo or imitation Steam button was created.

## Generation baseline

- Source `index.html` SHA-256: `389e8aa8685506edb33fcfe7089715eb70bac7733efb28444c13160a9a9db131`
- Unique extracted images: 6
- Extracted image bytes: 5893645
- English UTM content: `steam_widget_en`
- Portuguese UTM content: `steam_widget_pt`

## Review gate

Do not replace the production root page until the `/preview/` version has been reviewed in EN and PT-PT at desktop, tablet and mobile widths, with runtime screenshots and explicit approval.
