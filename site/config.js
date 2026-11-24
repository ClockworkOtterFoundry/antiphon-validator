// Deployment configuration. Both endpoints ship EMPTY: this makes local/preview builds
// honest by construction — the waitlist form explains it isn't live yet, and no telemetry
// beacon is ever sent. G3-3 (launch) sets these to the deployed Worker's URLs.
export const config = {
  // POST { email, note? } — see ../worker/README.md
  waitlistEndpoint: "https://antiphon-validator-api.clockworkotterfoundry.workers.dev/waitlist",
  // POST content-free validation events { format, outcome, fatals, warnings, rules }
  telemetryEndpoint: "https://antiphon-validator-api.clockworkotterfoundry.workers.dev/event",
  // POST evaluation-key request { name, email, company, country, building, formats[], ... }
  // — see ../worker/README.md. (The old /lead route stays on the Worker for the previously
  // deployed site; this site no longer calls it.)
  evaluationEndpoint: "https://antiphon-validator-api.clockworkotterfoundry.workers.dev/evaluation",
  // Flip to true on release day, once Antiphon 1.1 is published on NuGet (see ../RELEASE_DAY.md).
  // While false the evaluation form tells the truth: keys work with 1.1, which is not out yet.
  antiphon11Live: false,
};

/** State-dependent evaluation-form copy. Pure, so the headless tests can check both states. */
export function evaluationCopy(live) {
  return live
    ? {
        intro: "Send your request and we will reply with your free key, usually the same business day.",
        thanks: "Thanks, we will be in touch. We will reply with your free key, usually the same business day.",
      }
    : {
        intro:
          "Evaluation keys work with Antiphon 1.1, planned for 1 December 2026. Send your request and we will reply once 1.1 is published.",
        thanks: "Thanks, we will be in touch once 1.1 is published.",
      };
}
