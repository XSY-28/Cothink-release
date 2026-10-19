/** One backend today. Versions are opaque strings to task scheduling. */
export async function createVersioning(options) {
  const { createGitVersioning } = await import("./git-versioning.js");
  return createGitVersioning(options);
}
export function validateScope(scope) {
  if (!Array.isArray(scope) || !scope.length) throw Error("修改必须声明非空范围");
  return [
    ...new Set(
      scope.map((path) => {
        if (
          typeof path !== "string" ||
          !path ||
          path.startsWith("/") ||
          path.includes("\\") ||
          path.split("/").includes("..") ||
          path.split("/").includes(".git") ||
          path.includes("\0")
        )
          throw Error("修改范围必须是项目相对路径");
        return path === "." ? "." : path.replace(/^\.\//, "").replace(/\/$/, "");
      }),
    ),
  ];
}
export const inScope = (path, scope) =>
  scope.some((s) => s === "." || path === s || path.startsWith(s + "/"));
