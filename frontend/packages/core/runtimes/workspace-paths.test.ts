import { describe, expect, it } from "vitest";
import { relativeRuntimeDirectory, runtimeDirectoryName, runtimeDirectoryParent, runtimeWorkspaceDirectory } from "./workspace-paths";

describe("paths on a remote Runtime", () => {
  it.each([
    ["/Users/alice/code", "/Users/alice"], ["/Users", "/"], ["/", null],
    ["C:\\workbench\\app", "C:\\workbench"], ["C:\\workbench", "C:\\"], ["C:\\", null],
    ["\\\\server\\share\\app", "\\\\server\\share\\"], ["\\\\server\\share", null],
  ])("ascends %s without leaving its filesystem root", (path, parent) => {
    expect(runtimeDirectoryParent(path!)).toBe(parent);
  });

  it.each([
    ["/Users/alice/code", "/Users/alice/code/app", "app"],
    ["/Users/alice/code", "/Users/alice/code", "."],
    ["C:\\Work", "c:\\work\\app\\src", "app/src"],
    ["\\\\server\\share", "\\\\server\\share\\app", "app"],
    ["/work", "/work-other/app", null], ["/work", "/Work/app", null],
    ["/work", "/work/../elsewhere", null], ["C:\\work", "D:\\work\\app", null],
    ["/work", "~/work/app", null],
  ])("derives the working directory within %s", (root, path, relative) => {
    expect(relativeRuntimeDirectory(root!, path!)).toBe(relative);
  });

  it("previews the execution path using the remote path syntax", () => {
    expect(runtimeWorkspaceDirectory("C:\\Work", "app/src")).toBe("C:\\Work\\app\\src");
    expect(runtimeWorkspaceDirectory("/Users/alice/code", ".")).toBe("/Users/alice/code");
    expect(runtimeWorkspaceDirectory("/", "app")).toBe("/app");
    expect(runtimeWorkspaceDirectory("/work", "../other")).toBeNull();
    expect(runtimeWorkspaceDirectory("/work", "/other")).toBeNull();
    expect(runtimeDirectoryName("/Users/alice/My work/")).toBe("My work");
  });
});
