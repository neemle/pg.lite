# PostgreSQL license notice location

Built artifacts redistribute PostgreSQL, so they must ship its license notice. This
repository does not contain a PostgreSQL source tree; the notice is taken from the fetched,
checksum-verified upstream tree (its top-level `COPYRIGHT` file) at build time and written
next to the artifact in `dist/<version>/licenses/`.

The step that does this belongs to the build command (CDB-31) and release packaging (CDB-11).
Nothing is stored here except this note and the `.gitkeep` placeholder.
