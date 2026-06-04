// Copy text to the clipboard in BOTH secure and non-secure contexts.
//
// The async Clipboard API (navigator.clipboard) only exists in a *secure
// context* — https or localhost. When the GUI is opened from a phone over a
// plain-http LAN / Tailscale address (http://100.x.x.x:6677), it is undefined
// (or writeText rejects), so the copy buttons silently did nothing. Fall back
// to a hidden <textarea> + document.execCommand('copy') there — deprecated, but
// still the only synchronous copy path available outside a secure context.
//
// Returns true if the copy succeeded.
export async function copyText(text) {
  if (text == null) return false;
  const str = String(text);
  // Preferred path: real Clipboard API (secure context only).
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch {
    // permission denied / not allowed — fall through to the legacy path
  }
  // Legacy fallback: works over plain http (phone on the LAN / Tailscale).
  const ta = document.createElement('textarea');
  try {
    ta.value = str;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    // iOS Safari ignores select() on a textarea — an explicit range is needed.
    ta.setSelectionRange(0, str.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    // Always remove the node — even if execCommand/setSelectionRange threw, so a
    // failed copy never leaks a hidden textarea into the DOM.
    if (ta.parentNode) ta.parentNode.removeChild(ta);
  }
}
