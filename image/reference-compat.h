/*
 * Force-included into the reference build (image/build-reference.sh) of the releases whose pg_rewind defines a static
 * copy_file_range(): the libc header that declares the function comes first, then the name is moved out of the way for
 * the rest of the file, so pg_rewind's own function no longer conflicts with the declaration.
 */
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#define copy_file_range pg_rewind_copy_file_range
