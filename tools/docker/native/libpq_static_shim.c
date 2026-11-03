/*
 * libpq_static_shim.c - what a static link needs and the shared libpq normally provides.
 *
 * libpq.a is not self-contained: its objects call pg_char_to_encoding() and
 * pg_encoding_to_char(), which the shared libpq exports from its own copy of
 * src/common/encnames.c.  Where libpgcommon.a does not export them under these names (17 and
 * later: the library is compiled with USE_PRIVATE_ENCODING_FUNCS and has them with a _private
 * suffix), statically linked frontends (initdb pulls libpq objects in through fe_utils) get the
 * code under the _private names, so the public names are simply forwarded.  Where libpgcommon.a
 * does export them (16), its definitions are used: the ones here are weak, a strong definition
 * from the archive replaces them, and the _private names are never referenced.
 * Plain C on purpose: no PostgreSQL headers, no change to any PostgreSQL source.
 */
extern int	pg_char_to_encoding_private(const char *name) __attribute__((weak));
extern const char *pg_encoding_to_char_private(int encoding) __attribute__((weak));

__attribute__((weak)) int
pg_char_to_encoding(const char *name)
{
	return pg_char_to_encoding_private(name);
}

__attribute__((weak)) const char *
pg_encoding_to_char(int encoding)
{
	return pg_encoding_to_char_private(encoding);
}
