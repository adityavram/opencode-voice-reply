export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch {
    if (
      (specifier.startsWith(".") || specifier.startsWith("file://")) &&
      !specifier.endsWith(".ts") &&
      !specifier.endsWith(".mjs") &&
      !specifier.endsWith(".js")
    ) {
      return nextResolve(specifier + ".ts", context);
    }
    throw new Error(`Cannot resolve ${specifier}`);
  }
}