/**
 * A paired device on the LAN opens the app over plain http, which browsers don't count as a secure
 * context, so they leave out `crypto.randomUUID` (the workflow editor's new ids) and
 * `navigator.clipboard` (the copy buttons). This fills both in. On localhost and https both exist and
 * are left alone.
 */
export function fillInsecureContextGaps(): void {
  if (typeof crypto.randomUUID !== "function") {
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: randomUuid });
  }
  if (!("clipboard" in navigator) || !navigator.clipboard) {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copyThroughSelection } });
  }
}

/** A version 4 UUID from getRandomValues, which every context has. */
export function randomUuid(): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The pre-Clipboard-API way: select the text in an off-screen field and ask the browser to copy it. */
function copyThroughSelection(text: string): Promise<void> {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  // iOS ignores select() on its own.
  field.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy") ? Promise.resolve() : Promise.reject(new Error("The browser refused to copy"));
  } finally {
    field.remove();
  }
}
