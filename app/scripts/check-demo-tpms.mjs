#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Asserts demo TPMS 7d hourly daily-means agree with 30d daily buckets.
import { checkTpmsRangeAgreement, TPMS_DEMO_CURRENT } from "../src/demo/tpms-demo.mjs";

const nowMs = Date.parse("2026-11-05T03:02:46+09:00");
const r = checkTpmsRangeAgreement({ nowMs, tz: "Asia/Tokyo", current: { ...TPMS_DEMO_CURRENT } });
if (!r.ok) {
  console.error("✗ demo TPMS 7d↔30d agreement failed:");
  for (const i of r.issues) console.error("  -", i);
  process.exit(1);
}
console.log(`✓ demo TPMS 7d↔30d daily-mean agreement (${r.overlapDays} overlap days) + last→current`);
