# Packaging

Package-manager manifests for Clausage.

| Where | Files here | Published copy |
|---|---|---|
| winget | `winget/manifests/c/ckolpeter/Clausage/0.2.0/` (first submission) | [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) |
| Homebrew | `homebrew/Casks/clausage.rb` (template) | [ckolpeter/homebrew-tap](https://github.com/ckolpeter/homebrew-tap) |

## Automatic updates

When a GitHub Release is **published**, [`.github/workflows/packaging.yml`](../.github/workflows/packaging.yml):

1. **Homebrew:** runs [`scripts/update-homebrew-tap.sh`](../scripts/update-homebrew-tap.sh), which fills the new
   `version` and `sha256` (from the release API's `digest`) into `homebrew/Casks/clausage.rb` and pushes it to the tap.
2. **winget:** uses [Komac](https://github.com/russellbanks/Komac) (pinned version and checksum) to open an
   `Update: ckolpeter.Clausage …` PR against microsoft/winget-pkgs from the `ckolpeter/winget-pkgs` fork.
   Skipped until the first version is merged into winget-pkgs.

Pre-releases are skipped. It needs the repo secret **`PACKAGING_TOKEN`**: a *classic* token with only the
`public_repo` scope (Komac cannot open winget PRs with fine-grained tokens). Without it, both jobs are skipped with a warning.

To re-run for an existing release: Actions → Packaging → Run workflow → enter the tag (e.g. `v0.2.1`).

## By hand

```bash
TAG=v0.2.1 DRY_RUN=1 scripts/update-homebrew-tap.sh        # preview the cask
TAG=v0.2.1 TOKEN=<token> scripts/update-homebrew-tap.sh     # push it
komac update ckolpeter.Clausage --version 0.2.1 --urls https://github.com/ckolpeter/clausage/releases/download/v0.2.1/Clausage-0.2.1-win-x64.exe --submit
```

Edit `homebrew/Casks/clausage.rb` only to change the cask's structure (the workflow replaces `version` and `sha256`).
