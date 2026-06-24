// Ambient declarations for Bun text imports (`import x from "....md" with { type: "text" }`).
// Bun resolves these to the raw file contents as a string; tsc has no built-in
// knowledge of `.md` modules, so declare them here so type-checking succeeds.
declare module "*.md" {
  const content: string;
  export default content;
}
