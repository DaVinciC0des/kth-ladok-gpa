// Background service worker for the KTH Ladok GPA extension.
//
// The only job here is fetching public www.kth.se pages on behalf of the
// content script. Content-script fetches run inside the tab's own execution
// context and are subject to that page's Content-Security-Policy - Ladok's
// CSP is strict (the same reason the Ladok API calls are proxied
// same-origin), so a direct cross-origin fetch to kth.se from content.js can
// get silently blocked. A service worker's fetches aren't part of any page
// and aren't bound by any page's CSP, so we do it here instead and hand the
// result back over a runtime message.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "fetchKthPage") return false;

  fetch(message.url, { credentials: "omit" })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Request failed (${res.status}): ${message.url}`);
      const html = await res.text();
      sendResponse({ ok: true, html });
    })
    .catch((e) => {
      sendResponse({ ok: false, error: e.message });
    });

  return true; // keep the message channel open for the async sendResponse
});
