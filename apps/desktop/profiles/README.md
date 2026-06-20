# Signing Profiles

Put local Apple provisioning profiles here when building Mac App Store artifacts:

- `PagePair_Development.provisionprofile` for `npm --prefix apps/desktop run mas:dev`
- `PagePair_AppStore.provisionprofile` for `npm --prefix apps/desktop run mas:dist`

Do not commit real profiles, certificates, private keys, or exported keychains.
