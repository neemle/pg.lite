# Vendored packer

`xsfx-v0.2.0-x86_64.tar.gz` and `xsfx-v0.2.0-aarch64.tar.gz` are the release archives of v0.2.0 of the packer
[xsfx](https://github.com/ratushnyi-labs/xsfx) (a self-extracting packer, used by `--pack`), kept here byte for byte.
`image/fetch-xsfx.sh` uses them first and checks the SHA-256 it has pinned; it downloads the archive from the release page only
when a copy here is missing or does not match. They are here because the CI of a release must not depend on that download being up
(GitHub answered 504 for it for a quarter of an hour on 2026-11-08 and stopped the series).
