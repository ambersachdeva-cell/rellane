# Building and installing Rellane

This public repository is an early source snapshot. There is no supported public installer or notarized release. Build from source on an Apple Silicon Mac using the steps in the [README](../README.md).

The current package version is `0.2.3`. A locally packaged disk image would be named `Cadrane-0.2.3-arm64.dmg`. The product is Rellane, but the macOS app is **still called Cadrane**. Its bundle and user-data identity have been kept stable for existing local records.

## Development builds

The existing app was built with an Apple Development signing identity. Such a build is not notarized for distribution; Gatekeeper can report it as **rejected** on another Mac. The development workflow previously used `xattr -dr com.apple.quarantine /Applications/Cadrane.app` after verifying an owner-built copy. Do not run that command on an untrusted download.

The desktop app **never updates itself**. A new locally built app must be installed manually. Every folder grant is withdrawn when the app identity changes, so a user must review and grant folders again.

## Data location

The existing data directory is `~/Library/Application Support/Cadrane/`. Preserve it when installing a newer build. Deleting `/Applications/Cadrane.app` does not by itself delete this directory. Make a verified backup before deleting or moving data.

The source and tests are not a substitute for checking the installed app's behavior on the target Mac.
