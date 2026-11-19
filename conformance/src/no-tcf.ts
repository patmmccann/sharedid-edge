// Preloaded (`node --import`) by the Node.js target for case files built `no-tcf`. The server runs core unbundled, so
// there's no build-time `define`: this sets the same flag before core loads, and core's NO_TCF check (consent.ts)
// leaves the TC string undecoded, as in a bundle built --no-tcf. Nothing else should ever set it at run time.
(globalThis as { __SID_NO_TCF__?: boolean }).__SID_NO_TCF__ = true;
