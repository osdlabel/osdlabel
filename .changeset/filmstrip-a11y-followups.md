---
'osdlabel': minor
'@osdlabel/solid': patch
'@osdlabel/react': patch
---

Filmstrip accessibility follow-ups (#205):

- **Announced as a list.** The filmstrip is now a list labelled "Images" (`FILMSTRIP_LABEL`, exported from `osdlabel`), with one list item per image. Assistive tech announces what the thumbnails belong to and how many there are.
- **Larger clear target.** The clear badge's button is now a 24px target (WCAG 2.5.8). The badge is still drawn at 16px, centred in the target, so it sits 2px further in from the corner.
- **Valid markup.** The text placeholder inside a thumbnail button is a `<span>` rather than a `<div>`, since a button may only hold phrasing content. The layout is unchanged.
- **Label updates (SolidJS).** The filmstrip follows a change to an image's `label` again, matching React.
- **More focused controls keep their keys.** `shouldSkipKeyboardShortcut` now also leaves `Enter` and `Space` to a focused `<summary>` or `<select>`, and `Enter` to a link (`<a href>` or `role="link"`). A `<select>` opens on Space, and on Return on macOS.

The keyboard guide also explains when the browser may draw a focus ring around the viewer, and how to style it.
