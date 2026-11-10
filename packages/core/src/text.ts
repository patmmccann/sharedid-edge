// String helpers for request data. Loops rather than regular expressions such as /\/+$/ or /[ \t]+$/, which
// backtrack polynomially on long runs of the repeated character in hostile input.

/** `text` without trailing `char`s (a single UTF-16 code unit). */
export function trimEnd(text: string, char: string): string {
  const code = char.charCodeAt(0);
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === code) end--;
  return text.slice(0, end);
}
