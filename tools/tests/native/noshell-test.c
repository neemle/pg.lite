/* Tests for src/common/noshell.c (patch 0002). Plain C: only the three public functions are used. */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>

extern FILE *pg_noshell_popen(const char *command, const char *mode);
extern int	pg_noshell_pclose(FILE *stream);
extern int	pg_noshell_system(const char *command);

static int	failed = 0;

static void
check(const char *name, int ok)
{
	printf("%s %s\n", ok ? "PASS" : "FAIL", name);
	if (!ok)
		failed++;
}

static void
read_all(const char *path, char *buf, size_t n)
{
	FILE	   *f = fopen(path, "r");
	size_t		got;

	buf[0] = '\0';
	if (f == NULL)
		return;
	got = fread(buf, 1, n - 1, f);
	buf[got] = '\0';
	fclose(f);
}

/* Run a command in read mode and return everything it printed. */
static int
capture(const char *cmd, char *buf, size_t n)
{
	FILE	   *p = pg_noshell_popen(cmd, "r");
	size_t		got;

	buf[0] = '\0';
	if (p == NULL)
		return -1;
	got = fread(buf, 1, n - 1, p);
	buf[got] = '\0';
	return pg_noshell_pclose(p);
}

static int
refused(const char *cmd)
{
	errno = 0;
	return pg_noshell_system(cmd) == -1 && errno == EINVAL;
}

int
main(void)
{
	char		out[4096];
	int			st;
	FILE	   *w;

	st = capture("/bin/echo \"hello world\"", out, sizeof(out));
	check("popen r: double-quoted argument stays one word", st == 0 && strcmp(out, "hello world\n") == 0);

	capture("/bin/echo 'a b' \"c d\" e\\ f", out, sizeof(out));
	check("single quotes, double quotes and backslash-space", strcmp(out, "a b c d e f\n") == 0);

	capture("/bin/echo 'it'\\''s'", out, sizeof(out));
	check("the quoting appendShellString produces ('it'\\''s') round-trips", strcmp(out, "it's\n") == 0);

	st = pg_noshell_system("/bin/echo hi > \"/tmp/ns_out.txt\"");
	read_all("/tmp/ns_out.txt", out, sizeof(out));
	check("system: > \"file\" redirects stdout", st == 0 && strcmp(out, "hi\n") == 0);

	capture("/bin/cat < \"/tmp/ns_out.txt\"", out, sizeof(out));
	check("popen r: < \"file\" redirects stdin", strcmp(out, "hi\n") == 0);

	st = capture("/bin/ls /nonexistent_dir_for_noshell 2>&1", out, sizeof(out));
	check("2>&1 sends stderr into the pipe", strstr(out, "nonexistent_dir_for_noshell") != NULL && st != 0);

	pg_noshell_system("/bin/ls /nonexistent_dir_for_noshell > \"/tmp/ns_err.txt\" 2>&1");
	read_all("/tmp/ns_err.txt", out, sizeof(out));
	check("> \"file\" 2>&1 puts both streams in the file", strstr(out, "nonexistent_dir_for_noshell") != NULL);

	pg_noshell_system("/bin/ls /nonexistent_dir_for_noshell 2> \"/tmp/ns_err2.txt\"");
	read_all("/tmp/ns_err2.txt", out, sizeof(out));
	check("2> \"file\" captures stderr only", strstr(out, "nonexistent_dir_for_noshell") != NULL);

	w = pg_noshell_popen("/bin/cat > \"/tmp/ns_w.txt\"", "w");
	if (w != NULL)
		fputs("data\n", w);
	st = w ? pg_noshell_pclose(w) : -1;
	read_all("/tmp/ns_w.txt", out, sizeof(out));
	check("popen w: input reaches the command", st == 0 && strcmp(out, "data\n") == 0);

	check("exit status 0 is reported", WIFEXITED(pg_noshell_system("/bin/true")) && WEXITSTATUS(pg_noshell_system("/bin/true")) == 0);
	check("exit status 1 is reported", WEXITSTATUS(pg_noshell_system("/bin/false")) == 1);
	st = capture("/bin/false", out, sizeof(out));
	check("pclose returns the child's status", WEXITSTATUS(st) == 1);

	check("refused: pipe", refused("/bin/echo a | /bin/cat"));
	check("refused: command separator", refused("/bin/echo a ; /bin/echo b"));
	check("refused: background &", refused("/bin/sleep 1 &"));
	check("refused: variable expansion", refused("/bin/echo $HOME"));
	check("refused: variable expansion inside double quotes", refused("/bin/echo \"$HOME\""));
	check("refused: backquote substitution", refused("/bin/echo `id`"));
	check("refused: glob", refused("/bin/echo *"));
	check("refused: subshell", refused("(/bin/echo a)"));
	check("refused: unterminated quote", refused("/bin/echo 'abc"));
	check("refused: empty command", refused("   "));
	check("refused: redirection without a target", refused("/bin/echo hi >"));

	check("a program that does not exist fails cleanly", pg_noshell_system("/nonexistent/program") != 0);

	errno = 0;
	check("popen with an invalid mode is refused", pg_noshell_popen("/bin/true", "x") == NULL && errno == EINVAL);

	printf(failed ? "\n%d test(s) FAILED\n" : "\nall noshell tests passed\n", failed);
	return failed ? 1 : 0;
}
