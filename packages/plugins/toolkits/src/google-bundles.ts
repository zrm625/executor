const readOperation = (name: string): boolean =>
  ["get", "list", "export"].includes(name.split(".").at(-1) ?? "");

const templates = [
  {
    id: "google-email-readonly",
    name: "Email read-only",
    summary: "Current Gmail get and list tools.",
    matches: (name: string) => name.startsWith("gmail.") && readOperation(name),
  },
  {
    id: "google-photos-picker",
    name: "Photos picker",
    summary: "Picker sessions and explicitly selected media. No Library uploads.",
    matches: (name: string) => name.startsWith("photospicker."),
  },
  {
    id: "google-drive-readonly",
    name: "Drive read-only",
    summary: "Current Drive get, list, and export tools.",
    matches: (name: string) => name.startsWith("drive.") && readOperation(name),
  },
] as const;

/** Snapshot exact tool addresses. New operations are never granted implicitly. */
export const googleToolkitBundles = (
  tools: readonly { readonly name: string; readonly pattern: string }[],
) =>
  templates.flatMap(({ matches, ...template }) => {
    const patterns = [
      ...new Set(tools.filter((tool) => matches(tool.name)).map((tool) => tool.pattern)),
    ].sort((a, b) => a.localeCompare(b));
    return patterns.length > 0 ? [{ ...template, patterns }] : [];
  });
