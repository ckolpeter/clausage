# Packaging

Package-manager manifests for Clausage. Update them for every release.

| Where | Files here | Published copy |
|---|---|---|
| winget | `winget/manifests/c/ckolpeter/Clausage/<version>/` | PR to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) |
| Homebrew | `homebrew/Casks/clausage.rb` | [ckolpeter/homebrew-tap](https://github.com/ckolpeter/homebrew-tap) |

For a new version:

1. Get the SHA256 of each file from the GitHub release API (`digest` field), e.g.
   `curl -s https://api.github.com/repos/ckolpeter/clausage/releases/tags/vX.Y.Z`
2. winget: copy the version folder, update `PackageVersion`, `InstallerUrl`, `InstallerSha256`, `ReleaseDate`, `ReleaseNotesUrl`; run `winget validate --manifest <folder>`; open a PR titled `Update: ckolpeter.Clausage to X.Y.Z`.
3. Homebrew: update `version` and `sha256` in the cask and push it to `ckolpeter/homebrew-tap`.
