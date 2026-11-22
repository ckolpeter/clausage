#!/usr/bin/env bash
# Update the Clausage cask in ckolpeter/homebrew-tap for a published release.
# Used by .github/workflows/packaging.yml; can also be run by hand.
#
#   TAG=v0.2.1 TOKEN=<classic token, public_repo> scripts/update-homebrew-tap.sh
#   TAG=v0.2.1 DRY_RUN=1 scripts/update-homebrew-tap.sh   # print the cask, change nothing
#
# The SHA256 comes from the GitHub release API ("digest"), so nothing large is downloaded.
set -euo pipefail

: "${TAG:?TAG is required, e.g. v0.2.1}"
REPO="${REPO:-ckolpeter/clausage}"
TAP="${TAP:-ckolpeter/homebrew-tap}"
VERSION="${TAG#v}"
DMG="Clausage-${VERSION}-mac-universal.dmg"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/packaging/homebrew/Casks/clausage.rb"

auth=()
if [ -n "${GH_TOKEN:-}" ]; then auth=(-H "Authorization: Bearer $GH_TOKEN"); fi
release="$(curl -fsSL "${auth[@]}" "https://api.github.com/repos/$REPO/releases/tags/$TAG")"
sha="$(printf '%s' "$release" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const a = (JSON.parse(s).assets || []).find(x => x.name === process.argv[1]);
    process.stdout.write(a && a.digest ? a.digest.replace(/^sha256:/, "") : "");
  });' "$DMG")"
if ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::No SHA256 digest for $DMG in release $TAG" >&2
  exit 1
fi

cask="$(sed -E \
  -e "s/^  version \"[^\"]*\"/  version \"$VERSION\"/" \
  -e "s/^  sha256 \"[^\"]*\"/  sha256 \"$sha\"/" \
  "$TEMPLATE")"

if [ -n "${DRY_RUN:-}" ]; then
  printf '%s\n' "$cask"
  exit 0
fi

: "${TOKEN:?TOKEN is required (classic token with public_repo scope)}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone --quiet --depth 1 "https://x-access-token:${TOKEN}@github.com/${TAP}.git" "$work/tap"
printf '%s\n' "$cask" > "$work/tap/Casks/clausage.rb"
cd "$work/tap"
if git diff --quiet; then
  echo "Cask already at $VERSION; nothing to do."
  exit 0
fi
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet -am "clausage $VERSION"
git push --quiet origin HEAD
echo "Updated $TAP to clausage $VERSION ($sha)"
