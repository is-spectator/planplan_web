#!/usr/bin/env bash
# Run as a dedicated build user on Linux, in an extracted candidate directory.
# This builds a candidate; it neither switches /opt/.../current nor starts services.
set -euo pipefail
umask 077
candidate_dir="$(cd "${1:?Usage: build-candidate.sh /absolute/candidate}" && pwd)"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Linux x86_64 build required' >&2; exit 1; }
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo 'Node 24 required' >&2; exit 1; }
[[ "$(pnpm --version)" == 10.33.2 ]] || { echo 'pnpm 10.33.2 required' >&2; exit 1; }
python3 "$candidate_dir/deploy/verify-manifest.py" "$candidate_dir"
# Do not read build-time dotenv files or inject runtime credentials into Vite.
if find "$candidate_dir" -name '.env*' -print -quit | read -r _; then
  echo 'Dotenv files are forbidden in the candidate' >&2; exit 1
fi
(
  cd "$candidate_dir/frontend"
  env -u NODE_ENV npm ci --ignore-scripts --no-audit --no-fund
  npm run build
)
(
  cd "$candidate_dir/server"
  env -u NODE_ENV pnpm install --frozen-lockfile
  pnpm run build
  # Verify the platform-specific argon2 binding, without user data.
  node --input-type=module -e "import argon2 from 'argon2'; const h=await argon2.hash('candidate-selfcheck'); if(!await argon2.verify(h,'candidate-selfcheck'))process.exit(1)"
)
[[ ! -e "$candidate_dir/web" ]] || { echo 'Candidate was already built' >&2; exit 1; }
cp -R "$candidate_dir/frontend/dist" "$candidate_dir/web"
node "$candidate_dir/deploy/build-manifest.mjs" "$candidate_dir"
echo 'Candidate built. Target PostgreSQL 15 validation and runtime configuration are still required.'
