// C03/C05: one path interpretation for grants, projections and imports.
export const problem = (code, message, details) =>
  Object.assign(new Error(message), { code, details });
export function pathName(value, allowRoot = false) {
  if (value === "." && allowRoot) return value;
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.normalize("NFC") ||
    /[\\\x00-\x1f\x7f:]/.test(value) ||
    value.startsWith("/") ||
    value
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[. ]$/.test(p) ||
          p.toLowerCase() === ".git" ||
          p.toLowerCase().startsWith(".git~"),
      )
  )
    throw problem("PATH", "Use an unambiguous relative source path", {
      path: value,
    });
  return value;
}
export const covers = (scope, path) =>
  scope.some((p) => p === "." || path === p || path.startsWith(p + "/"));
export const intersects = (a, b) =>
  a
    .map(aliasKey)
    .some(
      (p) =>
        covers(b.map(aliasKey), p) ||
        b.map(aliasKey).some((q) => covers([p], q)),
    );
export const aliasKey = (p) => p.normalize("NFC").toLowerCase();
export function aliases(paths, code = "SCOPE") {
  const known = new Map();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const s = parts.slice(0, i).join("/"),
        k = aliasKey(s);
      if (known.has(k) && known.get(k) !== s)
        throw problem(code, "Case alias is unsupported", {
          paths: [known.get(k), s],
        });
      known.set(k, s);
    }
  }
}
export function scopeList(value, fallback) {
  value ??= fallback;
  if (!Array.isArray(value))
    throw problem("SCOPE", "scope must be an array of prefixes");
  const paths = [...new Set(value.map((p) => pathName(p, true)))];
  aliases(paths);
  return paths
    .filter((p) => !paths.some((q) => q !== p && covers([q], p)))
    .sort();
}
export function identifier(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value))
    throw problem("INPUT", "Invalid request/change identifier");
  return value;
}
