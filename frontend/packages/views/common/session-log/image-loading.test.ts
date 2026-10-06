import { expect, it } from "vitest";
import { deferStreamedImages } from "./image-loading";

it("preserves image content, dimensions and explicit loading while deferring unconfigured SSR images", () => {
  const source = '<p>&lt;img src="code"&gt;<IMG alt="a > b" src="/api/attachments/a/content" width="30" height="20"></p>'
    + '<img src="b" loading="eager"><img loading=lazy src="c"><img alt="loading=eager" src="d"/>';
  expect(deferStreamedImages(source)).toBe('<p>&lt;img src="code"&gt;<IMG loading="lazy" alt="a > b" src="/api/attachments/a/content" width="30" height="20"></p>'
    + '<img data-entry-image-frame="" src="b" loading="eager"><img data-entry-image-frame="" loading=lazy src="c"><img loading="lazy" data-entry-image-frame="" alt="loading=eager" src="d"/>');
  expect(deferStreamedImages(null)).toBeNull();
  expect(deferStreamedImages(undefined)).toBeUndefined();
  expect(deferStreamedImages(deferStreamedImages(source))).toBe(deferStreamedImages(source));
});

it.each([
  '<img src="a" width="640">',
  '<img src="a" width="0" height="240">',
  '<img src="a" width="640" height="unknown">',
  '<img src="a" alt="width=640 height=240">',
])("reserves incomplete or invalid dimensions at SSR: %s", html => {
  expect(deferStreamedImages(html)).toContain('data-entry-image-frame=""');
});

it("keeps valid dimensions, unquoted values and explicit loading without a fallback frame", () => {
  const html = "<IMG WIDTH=640 HEIGHT='240' loading=eager alt='a > b'>";
  expect(deferStreamedImages(html)).toBe(html);
});
