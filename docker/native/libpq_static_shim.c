/*
 * libpq_static_shim.c - what a static link needs and the shared libpq normally provides.
 *
 * libpq.a is not self-contained: its objects call pg_char_to_encoding() and
 * pg_encoding_to_char(), which the shared libpq exports from its own copy of
 * src/common/encnames.c.  Statically linked frontends (initdb pulls libpq objects in through
 * fe_utils) get the same code from libpgcommon.a under the names with a _private suffix
 * (the library is compiled with USE_PRIVATE_ENCODING_FUNCS), so the public names are simply
 * forwarded.  Plain C on purpose: no PostgreSQL headers, no change to any PostgreSQL source.
 */
extern int	pg_char_to_encoding_private(const char *name);
extern const char *pg_encoding_to_char_private(int encoding);

int
pg_char_to_encoding(const char *name)
{
	return pg_char_to_encoding_private(name);
}

const char *
pg_encoding_to_char(int encoding)
{
	return pg_encoding_to_char_private(encoding);
}
