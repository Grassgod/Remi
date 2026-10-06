import { expect, it } from "vitest";
import { deferStreamedImages } from "./image-loading";

it("preserves image content, dimensions and explicit loading while deferring unconfigured SSR images", () => {
  const source = '<p>&lt;img src="code"&gt;<IMG alt="a > b" src="/api/attachments/a/content" width="30" height="20"></p>'
    + '<img src="b" loading="eager"><img loading=lazy src="c"><img alt="loading=eager" src="d"/>';
  expect(deferStreamedImages(source)).toBe('<p>&lt;img src="code"&gt;<IMG loading="lazy" alt="a > b" src="/api/attachments/a/content" width="30" height="20"></p>'
    + '<img src="b" loading="eager"><img loading=lazy src="c"><img loading="lazy" alt="loading=eager" src="d"/>');
  expect(deferStreamedImages(null)).toBeNull();
  expect(deferStreamedImages(undefined)).toBeUndefined();
  expect(deferStreamedImages(deferStreamedImages(source))).toBe(deferStreamedImages(source));
});
