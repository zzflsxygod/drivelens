#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Regenerate api/THIRD_PARTY_LICENSES.txt (Rust crates in the drivelens-api binary / Docker image) and check that
# every dependency license is AGPL-compatible. The web app's list is generated at build time by vite.config.ts
# (dist-web/third-party-licenses.txt). Needs cargo-about and cargo-deny (cargo install cargo-about cargo-deny).
set -euo pipefail
cd "$(dirname "$0")/../api"
cargo deny check licenses
cargo about generate about.hbs -o THIRD_PARTY_LICENSES.txt
echo "api/THIRD_PARTY_LICENSES.txt: $(grep -c '^  - ' THIRD_PARTY_LICENSES.txt) crate entries"
