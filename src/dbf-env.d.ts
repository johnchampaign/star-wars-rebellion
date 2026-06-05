// Injected at build time by digital-boardgame-framework's versionStamp() Vite
// plugin (see vite.config.ts). Holds the git short SHA of the live build so the
// UpdateBanner can compare it against the deployed version.json and prompt
// long-open tabs to reload after a new deploy. In `vite dev` (no plugin define)
// this would be undefined — the banner simply never fires, which is fine.
declare const __DBF_BUILD_ID__: string;
