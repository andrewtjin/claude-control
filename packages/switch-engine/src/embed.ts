// Embedding a function's source in the enforcement guard, a dependency-free script generated at
// install time (see folderPath.ts and recordedFolder.ts for the functions embedded, and their
// self-containment contract). Its own module so every embeddable module can use it without
// importing another one.

/**
 * Emit `fn`'s source bound to `as` in the embedding scope — and ALSO to the function's own name
 * when that differs. A bundler that meets two top-level functions of one name renames one (esbuild
 * makes it `aliasKey2`), and renames the CALLS to it inside sibling functions too: the embedded
 * `resolveSessionBinding` would then call `aliasKey2`, which a plain `const aliasKey = ...` never
 * defines, and the guard would throw on every prompt (failing open — enforcement silently off). So
 * the emitted scope defines both names; the guard glue keeps calling the source name `as`. Order is
 * free: the functions only call each other at run time, after every `const` is initialized.
 */
export function embedFunctionAs(fn: (...args: never[]) => unknown, as: string): string {
  const own = fn.name;
  if (own === as || !/^[A-Za-z_$][\w$]*$/.test(own)) return `const ${as} = ${fn.toString()};`;
  return `const ${own} = ${fn.toString()};\nconst ${as} = ${own};`;
}
