/*
 * pg-launcher: entrypoint of the FROM scratch image. No shell is available, so this small
 * static program does what an entrypoint script would:
 *
 *   - PGDATA is a cluster (has PG_VERSION): do nothing, start the server.
 *   - PGDATA is empty: cold init with initdb, then configure network access.
 *   - PGDATA is not empty and not a cluster: refuse and exit 1; nothing is touched or cleaned.
 *
 * It then exec()s postgres, so the server is PID 1 and receives the container's signals
 * (the image sets STOPSIGNAL SIGINT = fast shutdown).  Extra arguments go to postgres.
 *
 * Environment: POSTGRES_PASSWORD (required for the first start), PGDATA (default below),
 *              POSTGRES_USER (default "postgres").
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define PREFIX "/usr/local/pgsql"
#define DEFAULT_PGDATA "/var/lib/postgresql/data"
#define PWFILE "/tmp/.pg-launcher-pw"

extern char **environ;

static void
die(const char *msg)
{
	fprintf(stderr, "pg-launcher: %s\n", msg);
	exit(1);
}

static int
run(char *const argv[])
{
	pid_t		pid;
	int			status;

	if (posix_spawn(&pid, argv[0], NULL, NULL, argv, environ) != 0)
	{
		fprintf(stderr, "pg-launcher: cannot execute %s: %s\n", argv[0], strerror(errno));
		return -1;
	}
	while (waitpid(pid, &status, 0) < 0)
		if (errno != EINTR)
			return -1;
	return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static int
dir_is_empty(const char *path, int *exists)
{
	DIR		   *d = opendir(path);
	struct dirent *e;
	int			empty = 1;

	*exists = (d != NULL);
	if (d == NULL)
		return 1;
	while ((e = readdir(d)) != NULL)
	{
		if (strcmp(e->d_name, ".") != 0 && strcmp(e->d_name, "..") != 0)
		{
			empty = 0;
			break;
		}
	}
	closedir(d);
	return empty;
}

static void
append(const char *dir, const char *file, const char *text)
{
	char		path[4096];
	FILE	   *f;

	snprintf(path, sizeof(path), "%s/%s", dir, file);
	f = fopen(path, "a");
	if (f == NULL || fputs(text, f) == EOF || fclose(f) != 0)
	{
		fprintf(stderr, "pg-launcher: cannot append to %s: %s\n", path, strerror(errno));
		exit(1);
	}
}

int
main(int argc, char **argv)
{
	const char *pgdata = getenv("PGDATA") ? getenv("PGDATA") : DEFAULT_PGDATA;
	const char *user = getenv("POSTGRES_USER") ? getenv("POSTGRES_USER") : "postgres";
	const char *password = getenv("POSTGRES_PASSWORD");
	char		version_file[4096];
	struct stat st;

	snprintf(version_file, sizeof(version_file), "%s/PG_VERSION", pgdata);
	if (stat(version_file, &st) != 0)
	{
		int			exists;

		if (!dir_is_empty(pgdata, &exists))
		{
			fprintf(stderr, "pg-launcher: %s is not empty and is not a PostgreSQL cluster; refusing to touch it\n", pgdata);
			return 1;
		}
		if (password == NULL || *password == '\0')
			die("POSTGRES_PASSWORD must be set for the first start");

		{
			int			fd = open(PWFILE, O_WRONLY | O_CREAT | O_TRUNC, 0600);
			char		userarg[256];
			char		pgdataarg[4096];
			char	   *initdb_argv[] = {
				PREFIX "/bin/initdb", "-D", pgdataarg, userarg, "--pwfile=" PWFILE,
				"--encoding=UTF8", "--locale=C.UTF-8",
#ifndef NO_BUILTIN_LOCALE
				/* the builtin provider (PostgreSQL 17 and later): the same ordering on every libc */
				"--locale-provider=builtin", "--builtin-locale=C.UTF-8",
#endif
				"--auth-local=trust", "--auth-host=scram-sha-256", NULL
			};
			int			rc;

			if (fd < 0 || write(fd, password, strlen(password)) < 0 || close(fd) != 0)
				die("cannot write the password file");
			snprintf(userarg, sizeof(userarg), "--username=%s", user);
			snprintf(pgdataarg, sizeof(pgdataarg), "%s", pgdata);
			rc = run(initdb_argv);
			unlink(PWFILE);
			if (rc != 0)
			{
				fprintf(stderr, "pg-launcher: initdb failed (status %d)\n", rc);
				return 1;
			}
		}
		append(pgdata, "postgresql.conf",
			   "\n# added by pg-launcher\nlisten_addresses = '*'\ntimezone = 'UTC'\nlog_timezone = 'UTC'\n");
		append(pgdata, "pg_hba.conf", "\nhost all all all scram-sha-256\n");
	}

	{
		char	  **args = calloc((size_t) argc + 4, sizeof(char *));
		int			n = 0;

		if (args == NULL)
			die("out of memory");
		args[n++] = PREFIX "/bin/postgres";
		args[n++] = "-D";
		args[n++] = (char *) pgdata;
		for (int i = 1; i < argc; i++)
			args[n++] = argv[i];
		args[n] = NULL;
		execv(args[0], args);
		fprintf(stderr, "pg-launcher: cannot execute %s: %s\n", args[0], strerror(errno));
		return 1;
	}
}
