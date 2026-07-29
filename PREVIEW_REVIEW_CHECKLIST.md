# Structured Website Preview — Review Checklist

This checklist is the approval gate for the non-production `/preview/` website.

## Protected production state

- [ ] Root `index.html` is unchanged from `main`.
- [ ] The public production website remains unaffected.

## Functional review

- [ ] English navigation and copy work correctly.
- [ ] PT-PT navigation and copy work correctly.
- [ ] Language switching also updates the Steam widget language and copy.
- [ ] Existing anchors, gameplay demo and contact links work.
- [ ] All extracted images load from `/assets/images/`.
- [ ] The official Steam widget loads and links to App ID `4997100`.
- [ ] Steam UTM parameters identify the official website and EN/PT widget content.

## Runtime widths

- [ ] Desktop wide.
- [ ] Desktop standard.
- [ ] Tablet.
- [ ] Mobile.

## Visual gate

- [ ] Runtime screenshots captured in EN and PT-PT.
- [ ] No unintended visual regressions against the current website.
- [ ] Steam widget is readable and does not overflow.
- [ ] Explicit approval received before replacing the production `index.html`.
