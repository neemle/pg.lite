#!/bin/sh
# Usage: not-implemented.sh <make-target> <owning-backlog-item>
# Fails (exit 2) so an unfinished contract target can never be mistaken for a pass.
target="${1:?target name required}"
owner="${2:?owning backlog item required}"
echo "make $target: NOT IMPLEMENTED (owned by $owner in the leasevibe project 'compact.db')." >&2
exit 2
