// Deployment configuration. Both endpoints ship EMPTY: this makes local/preview builds
// honest by construction — the waitlist form explains it isn't live yet, and no telemetry
// beacon is ever sent. G3-3 (launch) sets these to the deployed Worker's URLs.
export const config = {
  // POST { email, note? } — see ../worker/README.md
  waitlistEndpoint: "",
  // POST content-free validation events { format, outcome, fatals, warnings, rules }
  telemetryEndpoint: "",
};
